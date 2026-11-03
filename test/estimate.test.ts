import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { estimateClaude, estimateCodex, estimateKora, estimateOpencode, formatEstimate } from '../src/estimate.ts';

const LS_OUTPUT = ['total 2048', ...Array.from({ length: 30 }, (_, i) => `-rw-r--r--@  1 andrea  staff  ${1000 + i} 24 set 09:10 file-${i}.ts`)].join('\n');

const root = mkdtempSync(join(tmpdir(), 'toonarrow-estimate-'));

test('estimate: each client history is rebuilt as its request body and rewritten offline', async () => {
  // Claude Code transcript.
  const claude = join(root, 'claude', 'p1');
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    join(claude, 's1.jsonl'),
    [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: LS_OUTPUT }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const c = await estimateClaude(join(root, 'claude'), 0);
  assert.equal(c.sessions, 1);
  assert.equal(c.results, 1);
  assert.equal(c.resultChars, LS_OUTPUT.length);
  assert.ok(c.savedChars > 0);

  // Codex rollout with a skill listing in a developer message.
  const codex = join(root, 'codex', '2026', '11', '03');
  mkdirSync(codex, { recursive: true });
  const listing = '<skills_instructions>\n### Skill roots\n- `r1` = `/u/.agents/skills`\n### Available skills\n' + Array.from({ length: 12 }, (_, i) => `- skill-${i}: (file: r1/skill-${i}/SKILL.md)`).join('\n') + '\n</skills_instructions>';
  writeFileSync(
    join(codex, 'rollout-2026-11-03T10-00-00-x.jsonl'),
    [
      { type: 'session_meta', payload: {} },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: listing }] } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'x1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"ls -la"}); text(r.output);' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'x1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: LS_OUTPUT }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );
  const x = await estimateCodex(join(root, 'codex'), 0);
  assert.equal(x.sessions, 1);
  assert.equal(x.results, 1);
  assert.ok(x.savedChars > 0);
  assert.equal(x.listings, 1);
  assert.ok(x.listingSavedChars > 0 && x.listingSavedChars < x.listingChars);

  // OpenCode database.
  const db = join(root, 'opencode.db');
  const sql = new DatabaseSync(db);
  sql.exec('create table part (id text, message_id text, session_id text, time_created integer, time_updated integer, data text)');
  sql.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run('p1', 'm1', 's1', 10, 10, JSON.stringify({ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'ls -la' }, output: LS_OUTPUT } }));
  sql.close();
  const o = await estimateOpencode(db, 0);
  assert.equal(o.sessions, 1);
  assert.ok(o.savedChars > 0);
  assert.equal((await estimateOpencode(join(root, 'missing.db'), 0)).sessions, 0);

  // Kora session document.
  const kora = join(root, 'kora', 'sessions');
  mkdirSync(kora, { recursive: true });
  const result = { success: true, stdout: LS_OUTPUT, stderr: '', exit_code: 0 };
  writeFileSync(
    join(kora, 'session-1.json'),
    JSON.stringify({
      messages: [{ role: 'assistant', parts: [{ type: 'tool-call', toolCallId: 'k1', toolName: 'executeCommand', args: { command: 'ls -la' } }, { type: 'tool-result', toolCallId: 'k1', toolName: 'executeCommand', result }] }],
    }),
  );
  const k = await estimateKora(join(root, 'kora'), 0);
  assert.equal(k.sessions, 1);
  assert.ok(k.savedChars > 0);

  const text = formatEstimate([c, x, o, k], 30);
  assert.match(text, /last 30 days/);
  assert.match(text, /Codex\t1\t1\t/);
});
