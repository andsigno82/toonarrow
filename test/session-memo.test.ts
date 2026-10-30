import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoKey, remember } from '../src/compress/memo.ts';
import { rewriteAnthropic } from '../src/compress/request.ts';
import { SessionMemoStore } from '../src/session-memo.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'toonarrow-memo-'));

test('remember replays the first decision, including "unchanged"', () => {
  const store = new SessionMemoStore(dir());
  const memo = store.for('s1');
  assert.equal(remember(memo, 'a', 'raw', () => 'v1'), 'v1');
  assert.equal(remember(memo, 'a', 'raw', () => 'v2'), 'v1', 'a rule change does not touch a block already sent');
  assert.equal(remember(memo, 'b', 'raw', () => 'raw'), 'raw');
  assert.equal(remember(memo, 'b', 'raw', () => 'now compressible'), 'raw');
  assert.equal(remember(undefined, 'a', 'raw', () => 'v3'), 'v3', 'no memo: current rules');
});

test('decisions and the skill keep-list survive a restart; sessions are separate', () => {
  const d = dir();
  const first = new SessionMemoStore(d).for('s1');
  first.set('k', 'compressed');
  first.set('n', null);
  assert.deepEqual([...first.keepSkills(new Set(['b', 'a']))], ['b', 'a']);
  const again = new SessionMemoStore(d).for('s1');
  assert.equal(again.get('k'), 'compressed');
  assert.equal(again.get('n'), null);
  assert.deepEqual([...again.keepSkills(new Set(['z']))].sort(), ['a', 'b'], 'keep-list of the first request wins');
  assert.equal(new SessionMemoStore(d).for('s2').get('k'), undefined);
});

test('a truncated line is skipped; files are private; old sessions are pruned', () => {
  const d = dir();
  new SessionMemoStore(d).for('s1').set('k', 'v');
  const [file] = readdirSync(d);
  const path = join(d, file!);
  appendFileSync(path, '{"k":"cut","v":"par');
  assert.equal(new SessionMemoStore(d).for('s1').get('k'), 'v');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const old = (Date.now() - 30 * 24 * 3600_000) / 1000;
  utimesSync(path, old, old);
  new SessionMemoStore(d);
  assert.deepEqual(readdirSync(d), []);
});

test('a session file stops growing at its size cap', () => {
  const d = dir();
  const memo = new SessionMemoStore(d, { maxFileBytes: 200 }).for('s1');
  for (let i = 0; i < 20; i++) memo.set(`k${i}`, 'x'.repeat(30));
  const [file] = readdirSync(d);
  assert.ok(readFileSync(join(d, file!)).length <= 200);
  assert.equal(memo.get('k19'), 'x'.repeat(30), 'still answered from memory');
});

test('rewrites replay the session memo: a block first left unchanged stays unchanged', () => {
  const output = Array.from({ length: 40 }, () => 'retrying connection to localhost:5432').join('\n');
  const body = () => ({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'for i in 1 2; do ./probe; done' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] },
    ],
  });
  const memo = new SessionMemoStore(dir()).for('s1');
  memo.set(memoKey('shell', 'for i in 1 2; do ./probe; done', output), null);
  const kept = body();
  assert.equal(rewriteAnthropic(kept, memo).bashBlocks, 0);
  assert.equal((kept.messages[1]!.content[0] as { content: string }).content, output);
  const fresh = body();
  assert.equal(rewriteAnthropic(fresh).bashBlocks, 1, 'without the memo the current rules compress it');
});
