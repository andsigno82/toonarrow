import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RewriteStats } from './compress/request.ts';
import type { SkillStats } from './compress/skills.ts';
import type { Usage } from './usage.ts';
import type { Wire } from './wire.ts';

export interface LedgerEntry {
  ts: string;
  upstream: string;
  method: string;
  path: string;
  wire: Wire;
  status: number;
  durationMs: number;
  requestBytes: number;
  /** Size of the body actually forwarded, when toonarrow rewrote it. */
  sentBytes?: number;
  model?: string;
  stream?: boolean;
  sessionKey?: string;
  sessionSource?: string;
  client?: string;
  usage?: Usage;
  compression?: RewriteStats;
  skills?: SkillStats;
  /** Client hung up before the upstream stream ended. */
  clientClosedEarly?: boolean;
  error?: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export const dayStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Append-only JSONL usage log, one file per local day. */
export class Ledger {
  #dir: string;
  #ready: Promise<unknown>;

  constructor(dir: string) {
    this.#dir = dir;
    this.#ready = mkdir(dir, { recursive: true });
  }

  async append(entry: LedgerEntry): Promise<void> {
    await this.#ready;
    const file = join(this.#dir, `usage-${dayStamp(new Date(entry.ts))}.jsonl`);
    const line = JSON.stringify(entry) + '\n';
    try {
      await appendFile(file, line);
    } catch (e) {
      // The directory can disappear while the daemon runs (manual cleanup): recreate once.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await mkdir(this.#dir, { recursive: true });
      await appendFile(file, line);
    }
  }

  /** Reads entries from the last `days` local days (today included). */
  async read(days: number): Promise<LedgerEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    const minName = `usage-${dayStamp(since)}.jsonl`;
    const entries: LedgerEntry[] = [];
    for (const f of files.filter((f) => f.startsWith('usage-') && f >= minName).sort()) {
      for (const line of (await readFile(join(this.#dir, f), 'utf8')).split('\n')) {
        if (line) entries.push(JSON.parse(line) as LedgerEntry);
      }
    }
    return entries;
  }
}
