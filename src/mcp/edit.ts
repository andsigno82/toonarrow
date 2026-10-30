import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { displayPath, hashText, isBinary, splitRange } from './files.ts';
import type { Session } from './session.ts';

export interface EditItem {
  file_path: string;
  /** Omit to create a file (or, with overwrite, to replace it whole). */
  old_string?: string;
  new_string: string;
  replace_all?: boolean;
  overwrite?: boolean;
}

class EditError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Lines in a snippet or file; a trailing newline does not start a new line. */
const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0));
const lineAt = (text: string, offset: number): number => lineCount(text.slice(0, offset + 1)) || 1;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function lineOffsets(text: string, range: [number, number] | undefined): [number, number] {
  if (!range) return [0, text.length];
  const lines = text.split('\n');
  let start = 0;
  for (let i = 0; i < range[0] - 1 && i < lines.length; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = range[0] - 1; i < range[1] && i < lines.length; i++) end += lines[i]!.length + 1;
  return [start, Math.min(end, text.length)];
}

/** Tolerates trailing whitespace and typographic quotes, nothing else. */
function tolerantPattern(old: string): RegExp {
  const body = old
    .split('\n')
    .map((l) =>
      escapeRe(l.replace(/[ \t]+$/, ''))
        .replace(/['‘’]/g, "['‘’]")
        .replace(/["“”]/g, '["“”]'),
    )
    .join('[ \\t]*\\n');
  return new RegExp(body, 'g');
}

interface Match {
  index: number;
  length: number;
}

function findMatches(text: string, old: string, range: [number, number] | undefined): { matches: Match[]; tolerant: boolean } {
  const [lo, hi] = lineOffsets(text, range);
  const exact: Match[] = [];
  for (let i = text.indexOf(old, lo); i >= 0 && i + old.length <= hi; i = text.indexOf(old, i + old.length)) exact.push({ index: i, length: old.length });
  if (exact.length) return { matches: exact, tolerant: false };
  const re = tolerantPattern(old);
  re.lastIndex = lo;
  const tolerant: Match[] = [];
  for (let m = re.exec(text); m && m.index + m[0].length <= hi; m = re.exec(text)) {
    tolerant.push({ index: m.index, length: m[0].length });
    if (!m[0].length) re.lastIndex++;
  }
  return { matches: tolerant, tolerant: true };
}

function notFoundHint(text: string, old: string): string {
  const probe = old.split('\n').map((l) => l.trim()).find((l) => l.length >= 4);
  if (!probe) return '';
  const lines = text.split('\n');
  const near = lines.flatMap((l, i) => (l.includes(probe) ? [i + 1] : [])).slice(0, 3);
  return near.length ? ` The line "${probe.slice(0, 60)}" appears at line(s) ${near.join(', ')}: re-read that area and copy old_string exactly.` : '';
}

async function editFile(abs: string, rel: string, items: (EditItem & { range?: [number, number] })[], session: Session): Promise<string> {
  let original: string | undefined;
  try {
    const buf = await readFile(abs);
    if (isBinary(buf)) throw new EditError('binary', 'binary files cannot be edited');
    original = buf.toString('utf8');
  } catch (e) {
    if (e instanceof EditError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  const creating = original === undefined || original.trim() === '';
  const first = items[0]!;
  if (first.old_string === undefined && !first.overwrite && !creating) {
    throw new EditError('create_exists', 'file exists and is not empty: use old_string to edit it, or overwrite: true to replace it whole');
  }
  if (!creating) {
    const seen = session.seenHash(abs);
    if (!seen) throw new EditError('not_in_session', `file has not been read in this session; read it first with Search({ patterns: "${rel}" })`);
    if (seen !== hashText(original!)) throw new EditError('stale', `file changed on disk since you read it; read it again with Search({ patterns: "${rel}" })`);
  } else if (items.some((i) => i.old_string !== undefined && original === undefined)) {
    throw new EditError('missing', 'file does not exist: omit old_string to create it');
  }

  const crlf = original?.includes('\r\n') ?? false;
  let text = crlf ? original!.replace(/\r\n/g, '\n') : (original ?? '');
  let firstLine = Number.MAX_SAFE_INTEGER;
  let lastLine = 0;
  let added = 0;
  let removed = 0;
  const notes: string[] = [];

  for (const item of items) {
    if (item.old_string === undefined) {
      removed += lineCount(text);
      text = item.new_string;
      added += lineCount(text);
      firstLine = 1;
      lastLine = Math.max(lastLine, lineCount(text));
      continue;
    }
    if (item.old_string === '') throw new EditError('empty_old_string', 'old_string is empty: omit it to create a file');
    const { matches, tolerant } = findMatches(text, item.old_string, item.range);
    if (!matches.length) throw new EditError('not_found', `old_string not found${item.range ? ` in lines ${item.range[0]}-${item.range[1]}` : ''}.${notFoundHint(text, item.old_string)}`);
    if (matches.length > 1 && !item.replace_all) {
      const at = matches.slice(0, 5).map((m) => lineAt(text, m.index));
      throw new EditError('ambiguous', `old_string occurs ${matches.length} times (lines ${at.join(', ')}); add surrounding context, scope it with "${rel}#<start>-<end>", or pass replace_all`);
    }
    if (tolerant) notes.push('matched ignoring trailing whitespace/quote style');
    for (const m of [...matches].reverse()) {
      const start = lineAt(text, m.index);
      text = text.slice(0, m.index) + item.new_string + text.slice(m.index + m.length);
      firstLine = Math.min(firstLine, start);
      lastLine = Math.max(lastLine, start + Math.max(0, lineCount(item.new_string) - 1));
      removed += lineCount(item.old_string);
      added += lineCount(item.new_string);
    }
  }

  const next = crlf ? text.replace(/\n/g, '\r\n') : text;
  if (next === original) return `${rel} (unchanged: the edit produces identical content)`;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, next);
  session.markSeen(abs, hashText(next));
  const note = notes.length ? ` — ${[...new Set(notes)].join('; ')}` : '';
  if (original === undefined) return `${rel} (created, ${lineCount(text)} lines)${note}`;
  return `${rel}#${firstLine}-${Math.max(firstLine, lastLine)} (modified, +${added} -${removed} lines)${note}`;
}

/** Applies edits grouped per file; each file is atomic, files are independent. */
export async function edit(items: EditItem[], session: Session, cwd: string): Promise<{ text: string; isError: boolean }> {
  const groups = new Map<string, { rel: string; items: (EditItem & { range?: [number, number] })[] }>();
  for (const item of items) {
    const { path, range } = splitRange(item.file_path);
    const abs = resolve(cwd, path);
    const g = groups.get(abs) ?? { rel: displayPath(cwd, abs), items: [] };
    g.items.push({ ...item, range });
    groups.set(abs, g);
  }
  const out: string[] = [];
  let failed = 0;
  for (const [abs, g] of groups) {
    try {
      out.push(await editFile(abs, g.rel, g.items, session));
    } catch (e) {
      failed++;
      const code = e instanceof EditError ? e.code : 'io_error';
      out.push(`✗ ${g.rel} (${code})\n  ${(e as Error).message}`);
    }
  }
  if (failed) out.push(`${groups.size - failed} applied · ${failed} failed.`);
  return { text: out.join('\n'), isError: failed === groups.size };
}
