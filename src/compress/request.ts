import { editTopLevelObject, editTopLevelStrings, topLevelStringSpans } from './json.ts';
import { type Memo, memoKey, remember } from './memo.ts';
import { SEARCH_TOOLS } from './search.ts';
import { compressBashOutput } from './shell/index.ts';

type Json = Record<string, any>;

export interface RewriteStats {
  /** Shell results rewritten in this request (the whole history, not just the newest turn). */
  bashBlocks: number;
  bashCharsSaved: number;
  /** Results of non-shell search tools rewritten (OpenCode grep, Kora searchCode); absent in older ledger lines. */
  toolBlocks?: number;
  toolCharsSaved?: number;
}

const emptyStats = (): RewriteStats => ({ bashBlocks: 0, bashCharsSaved: 0, toolBlocks: 0, toolCharsSaved: 0 });

/** True when a rewrite changed something in the request. */
export const rewrote = (s: RewriteStats | undefined): boolean => !!s && (s.bashBlocks > 0 || (s.toolBlocks ?? 0) > 0);

/** Per-request state: savings counters and the session's memo of earlier decisions. */
interface Ctx {
  stats: RewriteStats;
  memo?: Memo;
}

/** Shell tool names: Claude Code `Bash`; OpenCode 2.x `shell`; older OpenCode and others `bash`; Kora CLI `executeCommand`. */
const SHELL_TOOLS = new Set(['Bash', 'bash', 'shell', 'executeCommand']);

function shellCommand(name: unknown, input: unknown): string | undefined {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name) || !input || typeof input !== 'object') return undefined;
  const command = (input as Json).command ?? (input as Json).cmd;
  return typeof command === 'string' ? command : undefined;
}

/** A non-shell search tool result, lossless; `is_error` results are never touched. */
function compressSearchInto(ctx: Ctx, tool: string, text: string): string {
  const result = remember(ctx.memo, memoKey('search', tool, text), text, () => SEARCH_TOOLS[tool]!(text));
  if (result === text) return text;
  ctx.stats.toolBlocks = (ctx.stats.toolBlocks ?? 0) + 1;
  ctx.stats.toolCharsSaved = (ctx.stats.toolCharsSaved ?? 0) + text.length - result.length;
  return result;
}

const searchTool = (name: unknown): string | undefined => (typeof name === 'string' && Object.hasOwn(SEARCH_TOOLS, name) ? name : undefined);

function compressInto(ctx: Ctx, command: string, text: string): string {
  const result = remember(ctx.memo, memoKey('shell', command, text), text, () => compressBashOutput(command, text).text);
  if (result === text) return text;
  ctx.stats.bashBlocks++;
  ctx.stats.bashCharsSaved += text.length - result.length;
  return result;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One tool call of a Codex code-mode script, in output order: an `exec_command`'s shell command, a
 * `write_stdin` to the session of a command still running (its output continues that command), or any other
 * tool, whose output is left alone (null).
 */
export type CodeCall = { cmd: string } | { stdin: number } | null;

/** End index of the string literal starting at i, or -1 (unterminated, or a template literal with `${`). */
function skipString(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && src[j + 1] === '{') return -1;
  }
  return -1;
}

/**
 * Replaces each `tools.<name>({...})` call of a script with `@<i>` and drops comments; string literals outside
 * calls stay as they are. Undefined when the script cannot be scanned safely.
 */
function scanToolCalls(src: string): { skeleton: string; calls: { name: string; args: string }[] } | undefined {
  const head = /tools\.([A-Za-z_$][\w$]*)\(\{/y;
  const calls: { name: string; args: string }[] = [];
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      if (end < 0) return undefined;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) return undefined;
      i = close + 2;
      continue;
    }
    head.lastIndex = i;
    const m = head.exec(src);
    if (!m) {
      out += c;
      i++;
      continue;
    }
    let j = head.lastIndex;
    for (let depth = 1; depth > 0; ) {
      if (j >= src.length) return undefined;
      const d = src[j]!;
      if (d === '"' || d === "'" || d === '`') {
        j = skipString(src, j);
        if (j < 0) return undefined;
        continue;
      }
      if (d === '{') depth++;
      else if (d === '}') depth--;
      j++;
    }
    if (src[j] !== ')') return undefined;
    calls.push({ name: m[1]!, args: src.slice(head.lastIndex - 1, j) });
    out += `@${calls.length - 1}`;
    i = j + 1;
  }
  return { skeleton: out, calls };
}

/** Raw source of a top-level property of a flat object literal: a double-quoted string or an integer. */
function topLevelProp(obj: string, key: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i]!;
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(obj, i);
      if (end < 0) return undefined;
      // A quoted key is followed by `:`; a value is skipped.
      const rest = /^\s*:\s*/.exec(obj.slice(end));
      if (depth === 1 && rest && obj.slice(i + 1, end - 1) === key) return propValue(obj, end + rest[0].length);
      i = end - 1;
      continue;
    }
    if (depth === 1 && (c === '{' || c === ',' || i === 0 || /[\s,{]/.test(obj[i - 1]!)) && obj.startsWith(key, i)) {
      const rest = /^\s*:\s*/.exec(obj.slice(i + key.length));
      if (rest && !/[\w$]/.test(obj[i - 1] ?? '')) return propValue(obj, i + key.length + rest[0].length);
    }
  }
  return undefined;
}

function propValue(obj: string, at: number): string | undefined {
  if (obj[at] === '"') {
    const end = skipString(obj, at);
    return end < 0 ? undefined : obj.slice(at, end);
  }
  return /^\d+(?![\w.])/.exec(obj.slice(at))?.[0];
}

function codeCall(call: { name: string; args: string }): CodeCall {
  if (call.name === 'exec_command') {
    const raw = topLevelProp(call.args, 'cmd');
    const cmd = raw === undefined ? undefined : parseJson(raw);
    return typeof cmd === 'string' ? { cmd } : null;
  }
  if (call.name === 'write_stdin') {
    const raw = topLevelProp(call.args, 'session_id');
    return raw !== undefined ? { stdin: Number(raw) } : null;
  }
  return null;
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const LIST = String.raw`\[\s*(@\d+(?:\s*,\s*@\d+)*)\s*,?\s*\]`;
const FOR = String.raw`for\s*\(\s*(?:const|let|var)\s+(${ID})\s+of\s+\1\s*\)\s*(?<open>\{\s*)?`;
const CLOSE = String.raw`\s*;?\s*(?<close>\}\s*)?;?`;
/** `const rs = await Promise.<kind>([...]);` then one text() per result: a for-of over rs, or rs.forEach(text). */
const promiseLoop = (kind: string, printed: string): string =>
  String.raw`\s*(?:const|let|var)\s+(${ID})\s*=\s*await\s+Promise\.${kind}\(\s*${LIST}\s*\)\s*;?\s*` +
  String.raw`(?:${FOR}text\(\s*(?:${printed})\s*\)${CLOSE}|\1\.forEach\(\s*text\s*\)\s*;?)`;
/**
 * The statements whose output toonarrow can attribute: each prints one text() part per call, in call order
 * (shapes observed in Codex 0.160-0.166 code mode). Printing a result object whole gives its JSON.
 */
const STATEMENTS: RegExp[] = [
  // text(await tools.X({...}));
  String.raw`\s*text\(\s*await\s+@(\d+)\s*\)\s*;?`,
  // const r = await tools.X({...}); text(r.output);  |  text(JSON.stringify(r));
  String.raw`\s*(?:const|let|var)\s+(${ID})\s*=\s*await\s+@(\d+)\s*;?\s*text\(\s*(?:\1\.output|JSON\.stringify\(\s*\1\s*\))\s*\)\s*;?`,
  // allSettled: text(r.status==="fulfilled" ? r.value.output|JSON.stringify(r.value) : String(r.reason)), text(JSON.stringify(r)), text(r)
  promiseLoop(
    'allSettled',
    String.raw`\3\.status\s*===?\s*(["'])fulfilled\5\s*\?\s*(?:\3\.value\.output|JSON\.stringify\(\s*\3\.value\s*\))\s*:\s*String\(\s*\3\.reason\s*\)|JSON\.stringify\(\s*\3\s*\)|\3`,
  ),
  // all: text(r.output), text(JSON.stringify(r)), text(r)
  promiseLoop('all', String.raw`\3\.output|JSON\.stringify\(\s*\3\s*\)|\3`),
].map((source) => new RegExp(source, 'y'));

/**
 * The calls of a code-mode script in output order, when the whole script is a sequence of the statements above
 * and uses each call once, in order; undefined otherwise (any other statement may print something else).
 */
function codeModeCalls(script: string): CodeCall[] | undefined {
  const scanned = scanToolCalls(script);
  if (!scanned || scanned.calls.length === 0) return undefined;
  const { skeleton, calls } = scanned;
  const order: number[] = [];
  for (let at = 0; at < skeleton.length && skeleton.slice(at).trim() !== ''; ) {
    let matched = false;
    for (const st of STATEMENTS) {
      st.lastIndex = at;
      const m = st.exec(skeleton);
      if (!m || st.lastIndex === at) continue;
      // Braces of a for body must pair up.
      if (Boolean(m.groups?.open) !== Boolean(m.groups?.close)) continue;
      for (const ref of m[0].matchAll(/@(\d+)/g)) order.push(Number(ref[1]));
      at = st.lastIndex;
      matched = true;
      break;
    }
    if (!matched) return undefined;
  }
  if (order.length !== calls.length || order.some((n, i) => n !== i)) return undefined;
  const out = calls.map(codeCall);
  return out.some((c) => c !== null) ? out : undefined;
}

/** Calls of a Responses API tool call, in output order, or undefined when it is not shell. */
export function codexCommands(item: Json): CodeCall[] | undefined {
  if (item.type === 'custom_tool_call' && item.name === 'exec' && typeof item.input === 'string') return codeModeCalls(item.input);
  if (item.type === 'function_call' && ['exec_command', 'shell', 'local_shell', 'bash', 'executeCommand'].includes(item.name) && typeof item.arguments === 'string') {
    const args = parseJson(item.arguments);
    if (typeof args?.cmd === 'string') return [{ cmd: args.cmd }];
    if (typeof args?.command === 'string') return [{ cmd: args.command }];
    if (Array.isArray(args?.command)) {
      const c = args.command as unknown[];
      // ["bash", "-lc", "<script>"] carries the real command last.
      if (c.length === 3 && c[1] === '-lc' && typeof c[2] === 'string') return [{ cmd: c[2] }];
      if (c.every((x) => typeof x === 'string')) return [{ cmd: c.join(' ') }];
    }
  }
  return undefined;
}

/** A Responses API tool call whose output toonarrow rewrites: code calls in output order, or a search tool's name. */
export type ResponsesCall = CodeCall[] | { search: string };

/**
 * What a Responses conversation has shown so far: its tool calls by call_id, and the command running behind
 * each exec session id (a later `write_stdin` output continues that command). Over a WebSocket one state lives
 * for the whole connection.
 */
export interface ResponsesState {
  calls: Map<string, ResponsesCall>;
  sessions: Map<number, string>;
}

export const newResponsesState = (): ResponsesState => ({ calls: new Map(), sessions: new Map() });

/** Shell calls as in `codexCommands`; also `function_call`s to a search tool (OpenCode `grep`, Kora `searchCode`). */
export function responsesCall(item: Json): ResponsesCall | undefined {
  const commands = codexCommands(item);
  if (commands) return commands;
  const search = item.type === 'function_call' ? searchTool(item.name) : undefined;
  return search === undefined ? undefined : { search };
}

/** JSON fields holding command output: Codex `output`; Kora CLI `stdout` and `stderr`. */
const OUTPUT_FIELDS = ['output', 'stdout', 'stderr'];

/**
 * Compresses the command output inside one tool result text: JSON with output fields (Codex, Kora CLI)
 * or plain text. In JSON only the output fields' bytes change; escapes and layout elsewhere stay as sent.
 */
function compressToolText(ctx: Ctx, command: string, text: string): string {
  const spans = text.trimStart().startsWith('{') ? topLevelStringSpans(text) : undefined;
  if (spans && OUTPUT_FIELDS.some((k) => spans.has(k))) {
    return editTopLevelStrings(text, OUTPUT_FIELDS, (_key, value) => compressInto(ctx, command, value));
  }
  // A Promise.allSettled result printed whole: {"status":"fulfilled","value":{..., "output": "..."}}.
  if (spans?.get('status') !== undefined) {
    const nested = editTopLevelObject(text, 'value', (raw) =>
      editTopLevelStrings(raw, OUTPUT_FIELDS, (_key, value) => compressInto(ctx, command, value)),
    );
    if (nested !== undefined) return nested;
  }
  return compressInto(ctx, command, text);
}

/** Responses API output text: also Codex's "...Output:\n<text>" form. */
function compressResponsesText(ctx: Ctx, command: string, text: string): string {
  const marker = text.trimStart().startsWith('{') ? -1 : text.indexOf('Output:\n');
  if (marker >= 0) return text.slice(0, marker + 8) + compressInto(ctx, command, text.slice(marker + 8));
  return compressToolText(ctx, command, text);
}

/** Codex's first part of a code-mode result: `Script completed\nWall time ...\nOutput:\n`. */
const SCRIPT_HEADER = /^Script \w+\nWall time /;

/** Session id of an exec result still running (`{"session_id": 27856, ...}`), if any. */
function runningSession(text: string): number | undefined {
  if (!text.trimStart().startsWith('{')) return undefined;
  const id = parseJson(text)?.session_id;
  return typeof id === 'number' ? id : undefined;
}

/**
 * Codex (Responses API, store=false so the whole history is resent): shell calls are
 * `custom_tool_call` exec scripts or `function_call` exec_command/shell, answered by the
 * matching *_output item with the same call_id. OpenCode and Kora CLI with an OpenAI sign-in use the same wire:
 * their shell and search tools are `function_call`s. Over a WebSocket a turn sends only new input, so the
 * call came from the server earlier: `state` holds those, and gains the calls and exec sessions found here.
 *
 * A code-mode result is a header part and one part per call, in call order: each exec_command part is
 * compressed with its own command, a write_stdin part with the command running in that session, any other
 * tool's part is left alone. Parts that do not line up one per call are left alone.
 */
export function rewriteResponses(body: Json, memo?: Memo, state: ResponsesState = newResponsesState()): RewriteStats {
  const stats = emptyStats();
  const ctx: Ctx = { stats, memo };
  if (!Array.isArray(body.input)) return stats;
  const command = (c: CodeCall): string | undefined => (c === null ? undefined : 'cmd' in c ? c.cmd : state.sessions.get(c.stdin));
  const remember = (c: CodeCall, text: string): void => {
    const id = c !== null ? runningSession(text) : undefined;
    const cmd = command(c);
    if (id !== undefined && cmd !== undefined) state.sessions.set(id, cmd);
  };
  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;
    const call = responsesCall(item);
    if (call !== undefined && typeof item.call_id === 'string') {
      state.calls.set(item.call_id, call);
      continue;
    }
    if ((item.type !== 'custom_tool_call_output' && item.type !== 'function_call_output') || !state.calls.has(item.call_id)) continue;
    const known = state.calls.get(item.call_id)!;
    if (!Array.isArray(known)) {
      if (typeof item.output === 'string') item.output = compressSearchInto(ctx, known.search, item.output);
      else if (Array.isArray(item.output) && item.output.length === 1 && item.output[0]?.type === 'input_text' && typeof item.output[0].text === 'string') {
        item.output[0].text = compressSearchInto(ctx, known.search, item.output[0].text);
      }
      continue;
    }
    if (typeof item.output === 'string') {
      if (known.length !== 1) continue;
      remember(known[0]!, item.output);
      const cmd = command(known[0]!);
      if (cmd !== undefined) item.output = compressResponsesText(ctx, cmd, item.output);
    } else if (Array.isArray(item.output)) {
      const texts = item.output.filter((p: Json) => p?.type === 'input_text' && typeof p.text === 'string');
      if (known.length === 1) {
        // One call: every part is that command's output (Codex's header part holds none).
        const cmd = command(known[0]!);
        for (const part of texts) remember(known[0]!, part.text);
        if (cmd !== undefined) for (const part of texts) part.text = compressResponsesText(ctx, cmd, part.text);
        continue;
      }
      const parts = texts.length > 0 && SCRIPT_HEADER.test(texts[0].text) ? texts.slice(1) : texts;
      if (parts.length !== known.length) continue;
      parts.forEach((p: Json, i: number) => {
        remember(known[i]!, p.text);
        const cmd = command(known[i]!);
        if (cmd !== undefined) p.text = compressToolText(ctx, cmd, p.text);
      });
    }
  }
  return stats;
}

/**
 * OpenAI Chat Completions (OpenCode via Z.AI, OpenCode Go, Kora CLI, other OpenAI-compatible providers):
 * assistant `tool_calls` to the shell tool, answered by `role: tool` messages with the same id.
 */
export function rewriteChat(body: Json, memo?: Memo): RewriteStats {
  const stats = emptyStats();
  const ctx: Ctx = { stats, memo };
  if (!Array.isArray(body.messages)) return stats;
  const commands = new Map<string, string>();
  const searches = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const fn = call?.function;
        if (typeof call?.id !== 'string') continue;
        const command = typeof fn?.arguments === 'string' ? shellCommand(fn.name, parseJson(fn.arguments)) : undefined;
        if (command !== undefined) commands.set(call.id, command);
        else if (searchTool(fn?.name)) searches.set(call.id, fn.name);
      }
    } else if (msg?.role === 'tool' && (commands.has(msg.tool_call_id) || searches.has(msg.tool_call_id))) {
      const command = commands.get(msg.tool_call_id);
      const rewrite = (text: string): string => (command !== undefined ? compressToolText(ctx, command, text) : compressSearchInto(ctx, searches.get(msg.tool_call_id)!, text));
      if (typeof msg.content === 'string') msg.content = rewrite(msg.content);
      else if (Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0]?.type === 'text') {
        msg.content[0].text = rewrite(msg.content[0].text);
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
export function rewriteAnthropic(body: Json, memo?: Memo): RewriteStats {
  const stats = emptyStats();
  const ctx: Ctx = { stats, memo };
  if (!Array.isArray(body.messages)) return stats;
  const commands = new Map<string, string>();
  const searches = new Map<string, string>();
  for (const msg of body.messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      const command = msg.role === 'assistant' && block?.type === 'tool_use' ? shellCommand(block.name, block.input) : undefined;
      if (command !== undefined) {
        commands.set(block.id, command);
      } else if (msg.role === 'assistant' && block?.type === 'tool_use' && searchTool(block.name)) {
        searches.set(block.id, block.name);
      } else if (msg.role === 'user' && block?.type === 'tool_result') {
        const command = commands.get(block.tool_use_id);
        const search = block.is_error ? undefined : searches.get(block.tool_use_id);
        if (command === undefined && search === undefined) continue;
        const rewrite = (text: string): string => (command !== undefined ? compressInto(ctx, command, text) : compressSearchInto(ctx, search!, text));
        if (typeof block.content === 'string') block.content = rewrite(block.content);
        else if (Array.isArray(block.content) && block.content.length === 1 && block.content[0]?.type === 'text') {
          block.content[0].text = rewrite(block.content[0].text);
        }
      }
    }
  }
  return stats;
}
