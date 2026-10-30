import { dayStamp } from './ledger.ts';
import type { LedgerEntry } from './ledger.ts';

export interface Totals {
  requests: number;
  /** Failed requests: HTTP >= 400, transport errors, or an error event inside a 2xx stream. */
  errors: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Estimated prompt tokens removed by toonarrow, per rewrite. */
  savedSkills: number;
  savedBash: number;
}

export interface SessionRow extends Totals {
  session: string;
  client: string;
  models: string[];
  first: string;
  last: string;
}

export interface Summary {
  days: number;
  generatedAt: string;
  totals: Totals;
  daily: Array<Totals & { day: string }>;
  sessions: SessionRow[];
  models: Array<Totals & { model: string }>;
  clients: Array<Totals & { client: string }>;
}

const zero = (): Totals => ({ requests: 0, errors: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, savedSkills: 0, savedBash: 0 });

/**
 * Prompt tokens a rewrite removed, estimated with the request's own token density: the provider counted
 * `input + cacheRead + cacheWrite` tokens for the body actually sent, so removed chars convert at the same rate.
 */
export function savedTokens(e: LedgerEntry): { skills: number; bash: number } {
  const skills = e.skills?.skillsCharsSaved ?? 0;
  const bash = e.compression?.bashCharsSaved ?? 0;
  const u = e.usage;
  const prompt = u ? u.input + u.cacheRead + u.cacheWrite : 0;
  const sent = e.sentBytes ?? e.requestBytes - skills - bash;
  if (!prompt || sent <= 0 || !(skills + bash)) return { skills: 0, bash: 0 };
  const perChar = prompt / sent;
  return { skills: Math.round(skills * perChar), bash: Math.round(bash * perChar) };
}

function add(t: Totals, e: LedgerEntry): void {
  t.requests++;
  if (e.error || e.status >= 400) t.errors++;
  if (e.usage) {
    t.input += e.usage.input;
    t.cacheRead += e.usage.cacheRead;
    t.cacheWrite += e.usage.cacheWrite;
    t.output += e.usage.output;
  }
  const saved = savedTokens(e);
  t.savedSkills += saved.skills;
  t.savedBash += saved.bash;
}

export function grouped<K extends string>(entries: LedgerEntry[], keyOf: (e: LedgerEntry) => string, name: K): Array<Totals & Record<K, string>> {
  const map = new Map<string, Totals>();
  for (const e of entries) {
    const k = keyOf(e);
    const t = map.get(k) ?? zero();
    add(t, e);
    map.set(k, t);
  }
  return [...map].map(([k, t]) => ({ ...t, [name]: k }) as Totals & Record<K, string>).sort((a, b) => b.requests - a.requests);
}

/** Short client label: "opencode/latest/2.2.0/cli" -> "opencode 2.2.0", "claude-cli/2.1.3 (x)" -> "claude-cli 2.1.3". */
export function clientLabel(client: string | undefined): string {
  if (!client) return '?';
  const parts = client.split(' ')[0]!.split('/');
  const version = parts.slice(1).find((p) => /^\d/.test(p));
  return version ? `${parts[0]} ${version}` : parts[0]!;
}

/** Aggregates ledger entries of the last `days` local days, today included. */
export function summarize(entries: LedgerEntry[], days: number, now: Date = new Date(), sessionLimit = 50): Summary {
  const totals = zero();
  const daily = new Map<string, Totals>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    daily.set(dayStamp(d), zero());
  }
  const sessions = new Map<string, SessionRow>();
  const inRange: LedgerEntry[] = [];
  for (const e of entries) {
    const day = daily.get(dayStamp(new Date(e.ts)));
    if (!day) continue;
    inRange.push(e);
    add(totals, e);
    add(day, e);
    const key = e.sessionKey ?? `no-session ${clientLabel(e.client)}`;
    const s = sessions.get(key) ?? { ...zero(), session: key, client: clientLabel(e.client), models: [], first: e.ts, last: e.ts };
    add(s, e);
    if (e.model && !s.models.includes(e.model)) s.models.push(e.model);
    if (e.ts < s.first) s.first = e.ts;
    if (e.ts > s.last) s.last = e.ts;
    sessions.set(key, s);
  }
  return {
    days,
    generatedAt: now.toISOString(),
    totals,
    daily: [...daily].map(([day, t]) => ({ ...t, day })),
    sessions: [...sessions.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, sessionLimit),
    models: grouped(inRange, (e) => e.model ?? '?', 'model'),
    clients: grouped(inRange, (e) => clientLabel(e.client), 'client'),
  };
}
