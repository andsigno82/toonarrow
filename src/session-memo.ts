import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Memo } from './compress/memo.ts';

/** A session's memo of block decisions plus the skill keep-list it started with. */
export interface SessionMemo extends Memo {
  /** The keep-list recorded on the session's first request; `current` is recorded when there is none yet. */
  keepSkills(current: ReadonlySet<string>): ReadonlySet<string>;
}

export interface SessionMemoOptions {
  /** Sessions untouched for longer than this are deleted when the store opens. */
  ttlMs?: number;
  /** A session file stops growing past this size; later blocks then follow the current rules. */
  maxFileBytes?: number;
  /** Sessions kept in memory. */
  maxLoaded?: number;
}

type Line = { k: string; v: string | null } | { skills: string[] };

/**
 * Session memos on disk: one append-only JSONL file per session under `dir`, named by a hash of the session key.
 * Files are private (0600). A missing, unreadable or truncated file only costs one cache rewrite for its blocks.
 */
export class SessionMemoStore {
  private readonly loaded = new Map<string, SessionMemo>();
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxFileBytes: number;
  private readonly maxLoaded: number;

  constructor(dir: string, opts: SessionMemoOptions = {}) {
    this.dir = dir;
    this.ttlMs = opts.ttlMs ?? 14 * 24 * 3600_000;
    this.maxFileBytes = opts.maxFileBytes ?? 32 * 1024 * 1024;
    this.maxLoaded = opts.maxLoaded ?? 32;
    this.prune();
  }

  /** Deletes session files older than the TTL. */
  prune(now = Date.now()): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs > this.ttlMs) rmSync(path, { force: true });
      } catch {
        // removed concurrently
      }
    }
  }

  for(sessionKey: string): SessionMemo {
    const cached = this.loaded.get(sessionKey);
    if (cached) {
      // Map order doubles as recency for eviction.
      this.loaded.delete(sessionKey);
      this.loaded.set(sessionKey, cached);
      return cached;
    }
    const memo = this.open(sessionKey);
    this.loaded.set(sessionKey, memo);
    if (this.loaded.size > this.maxLoaded) this.loaded.delete(this.loaded.keys().next().value!);
    return memo;
  }

  private open(sessionKey: string): SessionMemo {
    const path = join(this.dir, `${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}.jsonl`);
    const entries = new Map<string, string | null>();
    let skills: ReadonlySet<string> | undefined;
    let size = 0;
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      size = Buffer.byteLength(text);
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          const line = JSON.parse(raw) as Line;
          if ('skills' in line) skills ??= new Set(line.skills);
          else if (typeof line.k === 'string' && (typeof line.v === 'string' || line.v === null)) entries.set(line.k, line.v);
        } catch {
          // a line cut by a crash: that block is decided again
        }
      }
    }
    const append = (line: Line): void => {
      const data = `${JSON.stringify(line)}\n`;
      const bytes = Buffer.byteLength(data);
      if (size + bytes > this.maxFileBytes) return;
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        appendFileSync(path, data, { mode: 0o600 });
        size += bytes;
      } catch {
        // disk full or read-only: the decision still holds in memory for this process
      }
    };
    return {
      get: (key) => entries.get(key),
      set(key, value) {
        if (entries.has(key)) return;
        entries.set(key, value);
        append({ k: key, v: value });
      },
      keepSkills(current) {
        if (!skills) {
          skills = new Set(current);
          append({ skills: [...current].sort() });
        }
        return skills;
      },
    };
  }
}
