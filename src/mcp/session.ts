/**
 * Per-process state of one agent session (an MCP stdio server lives as long as its client).
 * Tracks what the agent has seen so Edit can refuse blind or stale edits and Search can
 * answer repeated reads with a stub.
 */
export class Session {
  #seen = new Map<string, string>();
  #returned = new Set<string>();

  /** Records that the agent saw `abs` with content hash `hash`. */
  markSeen(abs: string, hash: string): void {
    this.#seen.set(abs, hash);
  }

  seenHash(abs: string): string | undefined {
    return this.#seen.get(abs);
  }

  /** True if this exact view (file, range, content) was already returned; records it otherwise. */
  returnedBefore(key: string): boolean {
    if (this.#returned.has(key)) return true;
    this.#returned.add(key);
    return false;
  }
}
