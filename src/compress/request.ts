import { compressBashOutput } from './shell/index.ts';

type Json = Record<string, any>;

export interface RewriteStats {
  /** Shell results rewritten in this request (the whole history, not just the newest turn). */
  bashBlocks: number;
  bashCharsSaved: number;
}

const emptyStats = (): RewriteStats => ({ bashBlocks: 0, bashCharsSaved: 0 });

/** Shell tool names: Claude Code `Bash`; OpenCode 2.x `shell`; older OpenCode and others `bash`; Kora CLI `executeCommand`. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'executeCommand']);

function shellCommand(name: unknown, input: unknown): string | undefined {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name) || !input || typeof input !== 'object') return undefined;
  const command = (input as Json).command ?? (input as Json).cmd;
  return typeof command === 'string' ? command : undefined;
}

function compressInto(stats: RewriteStats, command: string, text: string): string {
  const r = compressBashOutput(command, text);
  if (!r.applied) return text;
  stats.bashBlocks++;
  stats.bashCharsSaved += text.length - r.text.length;
  return r.text;
}

/** One Codex code-mode statement whose output goes straight to the model: `text(await tools.exec_command({cmd:"...", ...}));` */
const CODE_MODE_CALL = /\s*text\(await tools\.exec_command\(\{\s*cmd:\s*("(?:\\.|[^"\\])*")[^{}]*\}\)\);?\s*/y;

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Commands of a code-mode script made only of `text(await tools.exec_command({cmd}))` statements, in order.
 * Any other statement (variables, post-processing) makes the output differ from the raw command output: undefined.
 */
function codeModeCommands(script: string): string[] | undefined {
  const call = new RegExp(CODE_MODE_CALL.source, 'y');
  const commands: string[] = [];
  while (call.lastIndex < script.length) {
    const start = call.lastIndex;
    const m = call.exec(script);
    if (!m || call.lastIndex === start) return undefined;
    const cmd = parseJson(m[1]!);
    if (typeof cmd !== 'string') return undefined;
    commands.push(cmd);
  }
  return commands.length ? commands : undefined;
}

/** Shell commands of a Responses API tool call, in output order, or undefined when it is not plain shell. */
export function codexCommands(item: Json): string[] | undefined {
  if (item.type === 'custom_tool_call' && item.name === 'exec' && typeof item.input === 'string') return codeModeCommands(item.input);
  if (item.type === 'function_call' && ['exec_command', 'shell', 'local_shell', 'executeCommand'].includes(item.name) && typeof item.arguments === 'string') {
    const args = parseJson(item.arguments);
    if (typeof args?.cmd === 'string') return [args.cmd];
    if (typeof args?.command === 'string') return [args.command];
    if (Array.isArray(args?.command)) {
      const c = args.command as unknown[];
      // ["bash", "-lc", "<script>"] carries the real command last.
      if (c.length === 3 && c[1] === '-lc' && typeof c[2] === 'string') return [c[2]];
      if (c.every((x) => typeof x === 'string')) return [c.join(' ')];
    }
  }
  return undefined;
}

/** JSON fields holding command output: Codex `output`; Kora CLI `stdout` and `stderr`. */
const OUTPUT_FIELDS = ['output', 'stdout', 'stderr'];

/**
 * Compresses the command output inside one tool result text: JSON with output fields (Codex, Kora CLI)
 * or plain text. JSON is re-serialized only when a field changed.
 */
function compressToolText(stats: RewriteStats, command: string, text: string): string {
  const json = text.trimStart().startsWith('{') ? parseJson(text) : undefined;
  const fields = json && typeof json === 'object' ? OUTPUT_FIELDS.filter((k) => typeof json[k] === 'string') : [];
  if (!fields.length) return compressInto(stats, command, text);
  const out = { ...json };
  for (const k of fields) out[k] = compressInto(stats, command, json[k]);
  return fields.some((k) => out[k] !== json[k]) ? JSON.stringify(out) : text;
}

/** Responses API output text: also Codex's "...Output:\n<text>" form. */
function compressResponsesText(stats: RewriteStats, command: string, text: string): string {
  const marker = text.trimStart().startsWith('{') ? -1 : text.indexOf('Output:\n');
  if (marker >= 0) return text.slice(0, marker + 8) + compressInto(stats, command, text.slice(marker + 8));
  return compressToolText(stats, command, text);
}

/**
 * Codex (Responses API, store=false so the whole history is resent): shell calls are
 * `custom_tool_call` exec scripts or `function_call` exec_command/shell, answered by the
 * matching *_output item with the same call_id.
 */
export function rewriteResponses(body: Json): RewriteStats {
  const stats = emptyStats();
  if (!Array.isArray(body.input)) return stats;
  const commands = new Map<string, string[]>();
  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;
    const calls = codexCommands(item);
    if (calls !== undefined && typeof item.call_id === 'string') {
      commands.set(item.call_id, calls);
      continue;
    }
    if ((item.type !== 'custom_tool_call_output' && item.type !== 'function_call_output') || !commands.has(item.call_id)) continue;
    const cmds = commands.get(item.call_id)!;
    if (typeof item.output === 'string') {
      if (cmds.length === 1) item.output = compressResponsesText(stats, cmds[0]!, item.output);
    } else if (Array.isArray(item.output)) {
      const texts = item.output.filter((p: Json) => p?.type === 'input_text' && typeof p.text === 'string');
      if (cmds.length === 1) {
        for (const part of texts) part.text = compressResponsesText(stats, cmds[0]!, part.text);
      } else {
        // Several calls: a header part, then one JSON result per text() call, in script order.
        const results = texts.filter((p: Json) => p.text.trimStart().startsWith('{'));
        if (results.length === cmds.length) results.forEach((p: Json, i: number) => (p.text = compressToolText(stats, cmds[i]!, p.text)));
      }
    }
  }
  return stats;
}

/**
 * OpenAI Chat Completions (OpenCode via Z.AI, OpenCode Go, Kora CLI, other OpenAI-compatible providers):
 * assistant `tool_calls` to the shell tool, answered by `role: tool` messages with the same id.
 */
export function rewriteChat(body: Json): RewriteStats {
  const stats = emptyStats();
  if (!Array.isArray(body.messages)) return stats;
  const commands = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const fn = call?.function;
        const command = typeof fn?.arguments === 'string' ? shellCommand(fn.name, parseJson(fn.arguments)) : undefined;
        if (command !== undefined && typeof call.id === 'string') commands.set(call.id, command);
      }
    } else if (msg?.role === 'tool' && commands.has(msg.tool_call_id)) {
      const command = commands.get(msg.tool_call_id)!;
      if (typeof msg.content === 'string') msg.content = compressToolText(stats, command, msg.content);
      else if (Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0]?.type === 'text') {
        msg.content[0].text = compressToolText(stats, command, msg.content[0].text);
      }
    }
  }
  return stats;
}

/**
 * Anthropic Messages (Claude Code `Bash`, OpenCode `shell` via MiniMax/Anthropic): tool_use
 * answered by a user tool_result whose content is a string or a single text block. Mutates `body`; the transform is a pure function of each
 * block, so every request in a session yields the same bytes and the cache prefix holds.
 */
export function rewriteAnthropic(body: Json): RewriteStats {
  const stats = emptyStats();
  if (!Array.isArray(body.messages)) return stats;
  const commands = new Map<string, string>();
  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      const command = msg.role === 'assistant' && block?.type === 'tool_use' ? shellCommand(block.name, block.input) : undefined;
      if (command !== undefined) {
        commands.set(block.id, command);
      } else if (msg.role === 'user' && block?.type === 'tool_result' && commands.has(block.tool_use_id)) {
        const command = commands.get(block.tool_use_id)!;
        if (typeof block.content === 'string') block.content = compressInto(stats, command, block.content);
        else if (Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === 'text') {
          block.content[0].text = compressInto(stats, command, block.content[0].text);
        }
      }
    }
  }
  return stats;
}
