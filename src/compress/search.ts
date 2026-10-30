/**
 * Search tools that are not shell commands, rewritten without losing anything: every match keeps its file, line
 * number and text, in the original order. Each function returns the text unchanged unless it fully recognises the
 * format, so a second pass, or a different tool with the same name, leaves the bytes alone.
 */
import { commonDir } from './shell/files.ts';

const MIN_CHARS = 500;

const relativeTo = (prefix: string): string[] => (prefix ? [`# paths below are relative to ${prefix}`] : []);

/**
 * OpenCode `grep`: "Found N matches", then per file an absolute `path:` line and `  Line N: text` lines.
 * Paths lose their common directory and `Line N:` becomes `N:`.
 */
export function compressOpencodeGrep(text: string): string {
  if (text.length < MIN_CHARS || !text.startsWith('Found ')) return text;
  const lines = text.split('\n');
  const paths: string[] = [];
  for (const l of lines.slice(1)) {
    if (l === '' || /^ {2}Line \d+: /.test(l) || /^\(.*\)$/.test(l)) continue;
    if (!/^\S.*:$/.test(l)) return text;
    paths.push(l.slice(0, -1));
  }
  if (!paths.length) return text;
  const prefix = commonDir(paths);
  const out = [lines[0]!, ...relativeTo(prefix)];
  for (const l of lines.slice(1)) {
    if (/^ {2}Line \d+: /.test(l)) out.push(`  ${l.slice(7)}`);
    else if (/^\S.*:$/.test(l) && !/^\(.*\)$/.test(l)) out.push(l.slice(prefix.length));
    else out.push(l);
  }
  return out.join('\n');
}

const KORA_KEYS = new Set(['success', 'results', 'count', 'truncated', 'note']);

/**
 * Kora `searchCode`: `{success, results: [{file, line, text}], count, truncated?, note?}` as JSON becomes
 * grep-style text with a header carrying count, truncation and note. Only successful results with exactly
 * these fields and single-line texts are rewritten.
 */
export function compressKoraSearch(text: string): string {
  if (text.length < MIN_CHARS || !text.trimStart().startsWith('{')) return text;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return text;
  }
  if (!json || json.success !== true || !Array.isArray(json.results) || !json.results.length) return text;
  if (!Object.keys(json).every((k) => KORA_KEYS.has(k)) || typeof json.count !== 'number') return text;
  if (json.truncated !== undefined && typeof json.truncated !== 'boolean') return text;
  if (json.note !== undefined && (typeof json.note !== 'string' || json.note.includes('\n'))) return text;
  for (const r of json.results) {
    if (!r || typeof r !== 'object' || Object.keys(r).length !== 3) return text;
    if (typeof r.file !== 'string' || !Number.isInteger(r.line) || typeof r.text !== 'string' || r.text.includes('\n') || r.file.includes('\n')) return text;
  }
  const prefix = commonDir(json.results.map((r: { file: string }) => r.file));
  const out = [`searchCode: ${json.count} results${json.truncated ? ' (truncated)' : ''}`];
  if (json.note !== undefined) out.push(`note: ${json.note}`);
  out.push(...relativeTo(prefix));
  let current: string | undefined;
  for (const r of json.results as Array<{ file: string; line: number; text: string }>) {
    if (r.file !== current) {
      out.push(`${r.file.slice(prefix.length)}:`);
      current = r.file;
    }
    out.push(`  ${r.line}: ${r.text}`);
  }
  return out.join('\n');
}

/** Non-shell tools with a verified result format, by tool name. */
export const SEARCH_TOOLS: Record<string, (text: string) => string> = {
  grep: compressOpencodeGrep,
  searchCode: compressKoraSearch,
};
