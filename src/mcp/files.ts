import { createHash } from 'node:crypto';
import { glob, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/** Directories never walked by globs (explicit file paths still work). */
export const IGNORED_DIR = /(^|\/)(node_modules|\.git|\.hg|\.svn|dist|build|target|\.next|\.nuxt|\.venv|venv|__pycache__|\.cache|\.turbo)$/;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface Target {
  abs: string;
  rel: string;
  /** 1-based inclusive line range from a `path#start-end` suffix. */
  range?: [number, number];
  mtimeMs: number;
  size: number;
  /** Named directly (not found through a glob). */
  explicit: boolean;
}

export function splitRange(pattern: string): { path: string; range?: [number, number] } {
  const m = /^(.*)#(\d+)(?:-(\d+))?$/.exec(pattern);
  if (!m) return { path: pattern };
  const start = Math.max(1, Number(m[2]));
  const end = m[3] ? Number(m[3]) : Number.MAX_SAFE_INTEGER;
  return { path: m[1]!, range: [start, Math.max(start, end)] };
}

export const hashText = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);

export const displayPath = (root: string, abs: string): string => {
  const rel = relative(root, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
};

export const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);

async function fileStat(abs: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const s = await stat(abs);
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves file paths and globs (relative to root) to files. Explicit paths keep their order;
 * glob matches are sorted by modification time, newest first.
 */
export async function expand(patterns: string[], root: string, limit: number): Promise<{ targets: Target[]; truncated: number }> {
  const targets: Target[] = [];
  const seen = new Set<string>();
  let truncated = 0;
  for (const pattern of patterns) {
    const { path, range } = splitRange(pattern);
    const abs = resolve(root, path);
    const direct = await fileStat(abs);
    if (direct) {
      if (!seen.has(abs)) targets.push({ abs, rel: displayPath(root, abs), range, ...direct, explicit: true });
      seen.add(abs);
      continue;
    }
    const matches: Target[] = [];
    for await (const p of glob(path, { cwd: root, exclude: (name: string) => IGNORED_DIR.test(name) })) {
      const file = resolve(root, p);
      if (seen.has(file)) continue;
      const s = await fileStat(file);
      if (!s) continue;
      seen.add(file);
      matches.push({ abs: file, rel: displayPath(root, file), range, ...s, explicit: false });
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
    targets.push(...matches);
  }
  if (targets.length > limit) {
    truncated = targets.length - limit;
    targets.length = limit;
  }
  return { targets, truncated };
}
