import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CompressConfig } from './config.ts';
import { rewriteAnthropic, rewriteChat, rewriteResponses } from './compress/request.ts';
import type { RewriteStats } from './compress/request.ts';
import { rewriteSkills } from './compress/skills.ts';
import { koraProfileRoot, opencodeDbPath } from './skill-usage.ts';

/**
 * `toonarrow estimate`: what the proxy would have saved on the local history of each client, before routing any
 * traffic through it. Each session is rebuilt as the request body its client sends and passed to the same
 * rewrite functions the proxy runs; nothing leaves the machine. Savings are counted once per tool result (or
 * skill listing): over HTTP a client resends its history on every request, so the bytes kept out of requests
 * are a multiple of these.
 */

type Json = Record<string, any>;

export interface ClientEstimate {
  client: string;
  sessions: number;
  /** Tool results seen and their characters. */
  results: number;
  resultChars: number;
  /** Characters removed from tool results (shell and search rules). */
  savedChars: number;
  /** Skill listings found in the stored context (Codex only: the others do not store their system prompt). */
  listings: number;
  listingChars: number;
  listingSavedChars: number;
}

const empty = (client: string): ClientEstimate => ({ client, sessions: 0, results: 0, resultChars: 0, savedChars: 0, listings: 0, listingChars: 0, listingSavedChars: 0 });

const textLength = (v: unknown): number => {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, p: any) => n + textLength(p?.text ?? p?.content ?? ''), 0);
  return 0;
};

const addStats = (e: ClientEstimate, s: RewriteStats): void => {
  e.savedChars += s.bashCharsSaved + (s.toolCharsSaved ?? 0);
};

async function* lines(file: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}

async function recentFiles(dir: string, pattern: string, since: number): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for await (const f of glob(pattern, { cwd: dir })) {
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs >= since) out.push(p);
    } catch {
      // removed while scanning
    }
  }
  return out.sort();
}

/** Claude Code transcripts: every `message` of user/assistant lines, as the Anthropic Messages history. */
export async function estimateClaude(projectsDir: string, since: number): Promise<ClientEstimate> {
  const e = empty('Claude Code');
  for (const file of await recentFiles(projectsDir, '**/*.jsonl', since)) {
    const messages: Json[] = [];
    for await (const line of lines(file)) {
      if (!line.includes('"message"')) continue;
      try {
        const m = JSON.parse(line)?.message;
        if ((m?.role === 'user' || m?.role === 'assistant') && Array.isArray(m.content)) messages.push({ role: m.role, content: m.content });
      } catch {
        // partial line
      }
    }
    if (!messages.length) continue;
    e.sessions++;
    for (const m of messages) for (const p of m.content) if (p?.type === 'tool_result') (e.results++, (e.resultChars += textLength(p.content)));
    addStats(e, rewriteAnthropic({ messages }));
  }
  return e;
}

/** Codex rollouts: the response items as the Responses API input, plus the developer messages' skill listing. */
export async function estimateCodex(sessionsDir: string, since: number, keep?: ReadonlySet<string>): Promise<ClientEstimate> {
  const e = empty('Codex');
  for (const file of await recentFiles(sessionsDir, '**/rollout-*.jsonl', since)) {
    const input: Json[] = [];
    const developer: Json[] = [];
    for await (const line of lines(file)) {
      if (!line.includes('"response_item"')) continue;
      try {
        const p = JSON.parse(line).payload;
        if (/^(custom_tool_call|function_call)(_output)?$/.test(p?.type)) input.push(p);
        else if (p?.type === 'message' && p.role === 'developer' && developer.length < 4) developer.push(p);
      } catch {
        // partial line
      }
    }
    if (!input.length && !developer.length) continue;
    e.sessions++;
    for (const p of input) if (String(p.type).endsWith('_output')) (e.results++, (e.resultChars += textLength(p.output)));
    addStats(e, rewriteResponses({ input }));
    const listed = developer.some((m) => JSON.stringify(m).includes('### Available skills'));
    if (listed) {
      const before = JSON.stringify(developer).length;
      const s = rewriteSkills({ input: developer }, 'openai-responses', keep);
      e.listings++;
      e.listingChars += developer.reduce((n, m) => n + textLength(m.content), 0) + s.skillsCharsSaved;
      e.listingSavedChars += s.skillsCharsSaved;
      void before;
    }
  }
  return e;
}

/** OpenCode: tool parts of the SQLite store, per session, as Chat Completions tool calls and results. */
export async function estimateOpencode(dbPath: string, since: number): Promise<ClientEstimate> {
  const e = empty('OpenCode');
  if (!existsSync(dbPath)) return e;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(`select session_id as session, data from part where time_created >= ? and json_extract(data, '$.type') = 'tool' and json_extract(data, '$.state.status') = 'completed' order by session_id, time_created`)
      .all(since) as Array<{ session: string; data: string }>;
    const bySession = new Map<string, Json[]>();
    for (const { session, data } of rows) {
      let part: Json;
      try {
        part = JSON.parse(data);
      } catch {
        continue;
      }
      const output = part.state?.output;
      if (typeof output !== 'string') continue;
      const msgs = bySession.get(session) ?? [];
      msgs.push({ role: 'assistant', tool_calls: [{ id: part.callID, type: 'function', function: { name: part.tool, arguments: JSON.stringify(part.state?.input ?? {}) } }] });
      msgs.push({ role: 'tool', tool_call_id: part.callID, content: output });
      bySession.set(session, msgs);
      e.results++;
      e.resultChars += output.length;
    }
    for (const messages of bySession.values()) {
      e.sessions++;
      addStats(e, rewriteChat({ messages }));
    }
  } finally {
    db.close();
  }
  return e;
}

/** Kora (Desktop and CLI) session documents: tool-call/tool-result parts as Chat Completions messages. */
export async function estimateKora(profileRoot: string, since: number): Promise<ClientEstimate> {
  const e = empty('Kora');
  for (const file of await recentFiles(join(profileRoot, 'sessions'), '*.json', since)) {
    let doc: Json;
    try {
      doc = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const messages: Json[] = [];
    for (const m of Array.isArray(doc.messages) ? doc.messages : []) {
      for (const p of Array.isArray(m?.parts) ? m.parts : []) {
        if (p?.type === 'tool-call') messages.push({ role: 'assistant', tool_calls: [{ id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: JSON.stringify(p.args ?? {}) } }] });
        else if (p?.type === 'tool-result' && p.isError !== true) {
          const content = typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? null);
          messages.push({ role: 'tool', tool_call_id: p.toolCallId, content });
          e.results++;
          e.resultChars += content.length;
        }
      }
    }
    if (!messages.length) continue;
    e.sessions++;
    addStats(e, rewriteChat({ messages }));
  }
  return e;
}

export async function estimateAll(days: number, compress: CompressConfig, env: NodeJS.ProcessEnv = process.env): Promise<ClientEstimate[]> {
  const since = Date.now() - days * 86_400_000;
  const keep = compress.skills ? new Set(compress.keepSkills) : undefined;
  return Promise.all([
    estimateClaude(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'), since),
    estimateCodex(join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'), since, keep),
    estimateOpencode(opencodeDbPath(env), since),
    estimateKora(koraProfileRoot(env), since),
  ]);
}

const pct = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : '-');
const tokens = (chars: number): string => {
  const t = Math.round(chars / 4);
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1e3 ? `${(t / 1e3).toFixed(1)}k` : String(t);
};

export function formatEstimate(rows: ClientEstimate[], days: number): string {
  const out = [`Estimated on the local history of the last ${days} days (≈ tokens = characters / 4):`, ''];
  out.push(['client', 'sessions', 'tool results', 'result tokens', 'saved', 'skill listings saved'].join('\t'));
  for (const r of rows) {
    if (!r.sessions) {
      out.push([r.client, '0', '-', '-', '-', '-'].join('\t'));
      continue;
    }
    const listing = r.listings ? `${tokens(r.listingSavedChars)} of ${tokens(r.listingChars)} (${pct(r.listingSavedChars, r.listingChars)}), ${r.listings} sessions` : '-';
    out.push([r.client, String(r.sessions), String(r.results), tokens(r.resultChars), `${tokens(r.savedChars)} (${pct(r.savedChars, r.resultChars)})`, listing].join('\t'));
  }
  out.push('', 'Counted once per tool result: clients that resend their history over HTTP keep these tokens out of every later request too.');
  return out.join('\n');
}
