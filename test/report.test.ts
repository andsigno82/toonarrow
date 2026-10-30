import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LedgerEntry } from '../src/ledger.ts';
import { clientLabel, savedTokens, summarize } from '../src/report.ts';

const entry = (patch: Partial<LedgerEntry>): LedgerEntry => ({
  ts: '2026-10-29T10:00:00.000Z',
  upstream: 'x',
  method: 'POST',
  path: '/v1/messages',
  wire: 'anthropic-messages',
  status: 200,
  durationMs: 1,
  requestBytes: 1000,
  ...patch,
});

test('saved tokens use the token density of the body actually sent', () => {
  // 400 tokens for 800 bytes sent: 0.5 tokens per removed char.
  const e = entry({ requestBytes: 2000, sentBytes: 800, usage: { input: 100, cacheRead: 250, cacheWrite: 50, output: 9, reasoning: 0 }, skills: { skillsHidden: 3, skillsCharsSaved: 1000 }, compression: { bashBlocks: 1, bashCharsSaved: 200 } });
  assert.deepEqual(savedTokens(e), { skills: 500, bash: 100 });
  // Without sentBytes (older entries) the sent size is the original minus the removed chars.
  assert.deepEqual(savedTokens({ ...e, sentBytes: undefined }), { skills: 500, bash: 100 });
  assert.deepEqual(savedTokens(entry({ usage: e.usage })), { skills: 0, bash: 0 });
  assert.deepEqual(savedTokens({ ...e, usage: undefined }), { skills: 0, bash: 0 });
});

test('summarize fills every local day, groups sessions, models and clients', () => {
  const now = new Date('2026-10-29T15:00:00');
  const usage = { input: 10, cacheRead: 30, cacheWrite: 0, output: 2, reasoning: 0 };
  const entries = [
    entry({ ts: new Date('2026-10-28T09:00:00').toISOString(), sessionKey: 'a', model: 'm1', client: 'opencode/latest/2.2.0/cli', usage }),
    entry({ ts: new Date('2026-10-29T09:00:00').toISOString(), sessionKey: 'a', model: 'm2', client: 'opencode/latest/2.2.0/cli', usage }),
    entry({ ts: new Date('2026-10-29T10:00:00').toISOString(), sessionKey: 'b', model: 'm1', client: 'claude-cli/2.1.3 (external, cli)', usage }),
    entry({ ts: new Date('2026-10-20T10:00:00').toISOString(), sessionKey: 'old', usage }),
  ];
  const s = summarize(entries, 3, now);
  assert.deepEqual(s.daily.map((d) => [d.day, d.requests]), [['2026-10-27', 0], ['2026-10-28', 1], ['2026-10-29', 2]]);
  assert.equal(s.totals.requests, 3);
  assert.equal(s.totals.cacheRead, 90);
  assert.deepEqual(s.sessions.map((r) => [r.session, r.requests, r.models.join(',')]), [['b', 1, 'm1'], ['a', 2, 'm1,m2']]);
  assert.deepEqual(s.models.map((r) => [r.model, r.requests]), [['m1', 2], ['m2', 1]]);
  assert.deepEqual(s.clients.map((r) => r.client).sort(), ['claude-cli 2.1.3', 'opencode 2.2.0']);
});

test('requests that are not inference stay out of every total and are only counted', () => {
  const s = summarize(
    [
      entry({ sessionKey: 's', model: 'm' }),
      entry({ wire: 'other', path: '/api/hello', client: 'Bun/1.4.4' }),
      entry({ wire: 'other', path: '/x', status: 502, error: 'upstream request: ENOTFOUND', client: 'curl/8.7.1' }),
    ],
    1,
    new Date('2026-10-29T15:00:00'),
  );
  assert.equal(s.totals.requests, 1);
  assert.equal(s.totals.errors, 0);
  assert.equal(s.otherRequests, 2);
  assert.deepEqual(s.sessions.map((r) => r.session), ['s']);
  assert.deepEqual(s.clients.map((r) => r.client), ['?']);
  assert.deepEqual(s.models.map((r) => r.model), ['m']);
});

test('errors count HTTP failures, transport errors and stream error events', () => {
  const s = summarize(
    [
      entry({ status: 200 }),
      entry({ status: 200, error: 'stream error: Gateway error 429' }),
      entry({ status: 404 }),
      entry({ status: 502, error: 'upstream request: ECONNREFUSED' }),
    ],
    1,
    new Date('2026-10-29T15:00:00'),
  );
  assert.equal(s.totals.requests, 4);
  assert.equal(s.totals.errors, 3);
});

test('clientLabel', () => {
  assert.equal(clientLabel('codex_cli_rs/0.160.1 (Mac OS 27.2.0; arm64)'), 'codex_cli_rs 0.160.1');
  assert.equal(clientLabel(undefined), '?');
  assert.equal(clientLabel('curl'), 'curl');
});
