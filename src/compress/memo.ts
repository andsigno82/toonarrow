import { createHash } from 'node:crypto';

/**
 * What a session decided the first time it saw a block, replayed on every later request of that session: a rule
 * upgrade or a config change then applies only to new blocks, and the provider's cached prefix keeps its bytes.
 * `get` returns the stored result, `null` when the block was left unchanged, `undefined` when never seen.
 */
export interface Memo {
  get(key: string): string | null | undefined;
  set(key: string, value: string | null): void;
}

export const memoKey = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('base64url').slice(0, 22);

/** Runs `compute` once per key: later calls replay the first result, including "unchanged" (`null`). */
export function remember(memo: Memo | undefined, key: string, original: string, compute: () => string): string {
  if (!memo) return compute();
  const known = memo.get(key);
  if (known !== undefined) return known ?? original;
  const result = compute();
  memo.set(key, result === original ? null : result);
  return result;
}
