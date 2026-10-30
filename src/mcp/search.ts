import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_FILE_BYTES, expand, hashText, isBinary } from './files.ts';
import type { Target } from './files.ts';
import { outline } from './outline.ts';
import type { OutlineSymbol } from './outline.ts';
import type { Session } from './session.ts';

export type SearchMode = 'paths' | 'content' | 'count';

export interface SearchParams {
  patterns: string[];
  path?: string;
  contentRegex?: string;
  ignoreCase?: boolean;
  /** Lines of context around each regex match. */
  context?: number;
  mode?: SearchMode;
  /** Structural outline instead of file content. */
  summary?: boolean;
}

const READ_LINES = 500;
const MAX_LINE_CHARS = 2000;
const MAX_MATCHES_PER_FILE = 50;
const MAX_CONTENT_FILES = 30;
const MAX_LISTED_FILES = 200;
const MAX_SCANNED_FILES = 5000;
const MAX_MATCHED_FILES = 100;

const size = (n: number): string => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`);
const clip = (l: string): string => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…(+${l.length - MAX_LINE_CHARS} chars)` : l);
const numbered = (lines: string[], from: number, to: number): string[] => lines.slice(from - 1, to).map((l, i) => `${from + i}\t${clip(l)}`);

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

async function readText(t: Target): Promise<string | { skip: string }> {
  if (t.size > MAX_FILE_BYTES && !t.range) return { skip: `too large (${size(t.size)}); read a range like "${t.rel}#1-200"` };
  const buf = await readFile(t.abs);
  if (isBinary(buf)) return { skip: `binary file (${size(t.size)})` };
  return buf.toString('utf8');
}

/** Hint for a collapsed gap: the first symbol that starts inside it. */
function gapHint(symbols: OutlineSymbol[] | undefined, from: number, to: number): string {
  const s = symbols?.find((x) => x.start >= from && x.start <= to);
  if (!s) return '';
  const label = s.label.length > 60 ? `${s.label.slice(0, 60)}…` : s.label;
  return ` [next: ${label} at line ${s.start}]`;
}

async function renderMatches(t: Target, lines: string[], hits: number[], context: number): Promise<string[]> {
  const shown = hits.slice(0, MAX_MATCHES_PER_FILE);
  const windows: [number, number][] = [];
  for (const h of shown) {
    const from = Math.max(1, h - context);
    const to = Math.min(lines.length, h + context);
    const last = windows[windows.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }
  const symbols = await outline(t.abs, lines.join('\n')).catch(() => undefined);
  const out = [`${t.rel} (${hits.length} match${hits.length === 1 ? '' : 'es'}, ${lines.length} lines):`];
  let cursor = 1;
  for (const [from, to] of windows) {
    if (from > cursor) out.push(`…${cursor}-${from - 1}${gapHint(symbols, cursor, from - 1)}`);
    out.push(...numbered(lines, from, to));
    cursor = to + 1;
  }
  if (hits.length > shown.length) out.push(`… +${hits.length - shown.length} more matches in this file; narrow the regex or read a range`);
  else if (cursor <= lines.length) out.push(`…${cursor}-${lines.length}${gapHint(symbols, cursor, lines.length)}`);
  return out;
}

async function regexSearch(p: SearchParams, targets: Target[], session: Session, mode: SearchMode): Promise<string[]> {
  let re: RegExp;
  try {
    re = new RegExp(p.contentRegex!, p.ignoreCase ? 'i' : '');
  } catch (e) {
    return [`error: invalid contentRegex: ${(e as Error).message}`];
  }
  const out: string[] = [];
  let files = 0;
  let total = 0;
  let skippedFiles = 0;
  for (const t of targets) {
    const text = await readText(t);
    if (typeof text !== 'string') continue;
    const lines = splitLines(text);
    const hits: number[] = [];
    lines.forEach((l, i) => re.test(l) && hits.push(i + 1));
    if (!hits.length) continue;
    total += hits.length;
    if (++files > MAX_MATCHED_FILES) {
      skippedFiles++;
      continue;
    }
    session.markSeen(t.abs, hashText(text));
    if (mode === 'count') out.push(`${t.rel}: ${hits.length}`);
    else out.push(...(await renderMatches(t, lines, hits, Math.max(0, p.context ?? 0))));
  }
  if (!files) return [`no matches for /${p.contentRegex}/ in ${targets.length} file(s)`];
  if (skippedFiles) out.push(`[+${skippedFiles} more files with matches; narrow the patterns]`);
  if (mode === 'count') out.push(`total: ${total} in ${Math.min(files, MAX_MATCHED_FILES)} file(s)`);
  return out;
}

async function readFiles(p: SearchParams, targets: Target[], session: Session): Promise<string[]> {
  const out: string[] = [];
  for (const t of targets.slice(0, MAX_CONTENT_FILES)) {
    const text = await readText(t);
    if (typeof text !== 'string') {
      out.push(`${t.rel}: skipped, ${text.skip}`);
      continue;
    }
    const lines = splitLines(text);
    const hash = hashText(text);
    if (!lines.length) {
      session.markSeen(t.abs, hash);
      out.push(`${t.rel}: (empty file)`);
      continue;
    }
    if (p.summary) {
      const symbols = await outline(t.abs, text).catch(() => undefined);
      if (symbols?.length) {
        out.push(`${t.rel} (${lines.length} lines, ${size(t.size)}) outline:`);
        for (const s of symbols) out.push(`${'  '.repeat(s.depth)}${s.start}-${s.end} ${s.label}`);
        continue;
      }
      out.push(`${t.rel}: no outline available for this file type, showing content`);
    }
    const from = t.range?.[0] ?? 1;
    const to = Math.min(lines.length, t.range?.[1] ?? READ_LINES);
    if (from > lines.length) {
      out.push(`${t.rel}: range starts after the end of the file (${lines.length} lines)`);
      continue;
    }
    session.markSeen(t.abs, hash);
    if (session.returnedBefore(`${t.abs}#${from}-${to}@${hash}`)) {
      out.push(`${t.rel}#${from}-${to}: [unchanged since your last read]`);
      continue;
    }
    out.push(`${t.rel} (${lines.length} lines, ${size(t.size)}):`, ...numbered(lines, from, to));
    if (to < lines.length) out.push(`[lines ${from}-${to} of ${lines.length}; continue with "${t.rel}#${to + 1}-${Math.min(lines.length, to + READ_LINES)}"]`);
  }
  if (targets.length > MAX_CONTENT_FILES) out.push(`[+${targets.length - MAX_CONTENT_FILES} more files not read; narrow the patterns]`);
  return out;
}

/**
 * Normalizes the patterns argument. Some models (GLM via OpenCode) send the array JSON-encoded
 * as a single string: `"[\"a.ts\", \"b.ts\"]"`.
 */
export function normalizePatterns(patterns: string | string[]): string[] {
  if (Array.isArray(patterns)) return patterns;
  const trimmed = patterns.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
    } catch {
      // Not JSON: a glob character class like "[ab].ts" stays a single pattern.
    }
  }
  return [patterns];
}

export async function search(p: SearchParams, session: Session, cwd: string): Promise<string> {
  const root = resolve(cwd, p.path ?? '.');
  const scanning = p.contentRegex !== undefined;
  const { targets, truncated } = await expand(p.patterns, root, scanning ? MAX_SCANNED_FILES : MAX_LISTED_FILES);
  if (!targets.length) return `no files matched ${p.patterns.join(', ')} under ${root}`;

  const mode: SearchMode = p.mode ?? (scanning || p.summary || targets.every((t) => t.explicit) ? 'content' : 'paths');
  let out: string[];
  if (scanning) out = await regexSearch(p, targets, session, mode === 'paths' ? 'count' : mode);
  else if (mode === 'paths') out = targets.map((t) => t.rel);
  else if (mode === 'count') out = [`${targets.length} file(s)`];
  else out = await readFiles(p, targets, session);
  if (truncated) out.push(`[+${truncated} more files not ${scanning ? 'scanned' : 'listed'}; narrow the patterns]`);
  return out.join('\n');
}
