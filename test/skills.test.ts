import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compactSkillListing, rewriteSkills } from '../src/compress/skills.ts';
import { readClaudeUsage, readKoraUsage, readOpencodeUsage } from '../src/skill-usage.ts';
import type { SkillUsage } from '../src/skill-usage.ts';

const skill = (id: string, name = id): string =>
  `  <skill>\n    <id>${id}</id>\n    <name>${name}</name>\n    <description>Use when <x> needs ${id}.</description>\n  </skill>\n`;
const listing = (...entries: string[]): string => `Intro\n<available_skills>\n${entries.join('')}</available_skills>\n\nInstructions from: AGENTS.md`;

test('keeps used skills verbatim and lists the rest by id', () => {
  const text = listing(skill('ab-testing'), skill('code'), skill('report', 'Report'), skill('xlsx'));
  const r = compactSkillListing(text, new Set(['code', 'Report']));
  assert.equal(r.hidden, 2);
  assert.equal(
    r.text,
    listing(skill('code'), skill('report', 'Report')).replace(
      '</available_skills>',
      '  <more_skills note="descriptions omitted; load one by id with the skill tool when its name fits the task">ab-testing, xlsx</more_skills>\n</available_skills>',
    ),
  );
});

test('is deterministic and idempotent', () => {
  const text = listing(skill('a'), skill('b'), skill('c'));
  const once = compactSkillListing(text, new Set(['b']));
  assert.equal(compactSkillListing(text, new Set(['b'])).text, once.text);
  assert.deepEqual(compactSkillListing(once.text, new Set(['b'])), { text: once.text, hidden: 0 });
});

test('leaves text without a listing, or with every skill kept, untouched', () => {
  assert.deepEqual(compactSkillListing('plain prompt', new Set()), { text: 'plain prompt', hidden: 0 });
  const text = listing(skill('a'));
  assert.deepEqual(compactSkillListing(text, new Set(['a'])), { text, hidden: 0 });
});

test('request-level rewrite is idempotent for every wire format', () => {
  const text = listing(skill('a'), skill('b'));
  const keep = new Set(['a']);
  const bodies: Array<[Record<string, any>, 'anthropic-messages' | 'openai-chat' | 'openai-responses']> = [
    [{ system: [{ type: 'text', text }] }, 'anthropic-messages'],
    [{ messages: [{ role: 'system', content: text }] }, 'openai-chat'],
    [{ instructions: text }, 'openai-responses'],
  ];
  for (const [body, wire] of bodies) {
    rewriteSkills(body, wire, keep);
    const once = JSON.stringify(body);
    assert.deepEqual(rewriteSkills(body, wire, keep), { skillsHidden: 0, skillsCharsSaved: 0 });
    assert.equal(JSON.stringify(body), once);
  }
});

test('rewrites the system texts of each wire format', () => {
  const text = listing(skill('a'), skill('b'));
  const keep = new Set(['a']);
  const anthropic = { system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: text }] };
  assert.equal(rewriteSkills(anthropic, 'anthropic-messages', keep).skillsHidden, 1);
  assert.deepEqual(anthropic.system[0]!.cache_control, { type: 'ephemeral' });
  assert.equal(anthropic.messages[0]!.content, text, 'user messages are never touched');

  const chat = { messages: [{ role: 'system', content: text }] };
  assert.equal(rewriteSkills(chat, 'openai-chat', keep).skillsHidden, 1);

  const responses = { instructions: text, input: [{ role: 'developer', content: [{ type: 'input_text', text }] }] };
  const stats = rewriteSkills(responses, 'openai-responses', keep);
  assert.equal(stats.skillsHidden, 2);
  assert.equal(stats.skillsCharsSaved, 2 * (text.length - responses.instructions.length));
});

test('kora cli listing: used skills keep their line, the rest collapse into one line of names', () => {
  const intro = 'Before responding, evaluate each skill below against the user\'s request.';
  const text = `Base prompt\n\n## Available Skills\n${intro}\n\n- **code**: Expert coding workflow\n- **xlsx**: Spreadsheets\n- **ads**: \n\n## Active Skills\nbody`;
  const r = compactSkillListing(text, new Set(['code']));
  assert.equal(r.hidden, 2);
  assert.equal(
    r.text,
    `Base prompt\n\n## Available Skills\n${intro}\n\n- **code**: Expert coding workflow\n- Other skills, descriptions omitted (load one by name with the \`skill\` tool when its name fits the task): xlsx, ads\n\n## Active Skills\nbody`,
  );
  assert.deepEqual(compactSkillListing(r.text, new Set(['code'])), { text: r.text, hidden: 0 }, 'idempotent');
  // Listing at the very end of the prompt, without a trailing newline.
  assert.ok(compactSkillListing(`## Available Skills\n${intro}\n\n- **a**: x\n- **b**: y`, new Set()).text.endsWith(': a, b'));
});

test('reads skill usage from Kora session documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'toonarrow-kora-'));
  mkdirSync(join(root, 'sessions'));
  const part = (name: string) => ({ args: { name }, state: 'call', toolCallId: 'c', toolName: 'skill', type: 'tool-call' });
  writeFileSync(join(root, 'sessions', 'session-1.json'), JSON.stringify({ messages: [{ parts: [part('code'), { toolName: 'skill', type: 'tool-result' }, part('code')] }] }));
  writeFileSync(join(root, 'sessions', 'session-2.json'), '{"toolName":"skill" broken');
  const usage: SkillUsage = new Map();
  await readKoraUsage(root, usage);
  assert.deepEqual(Object.fromEntries(usage), { code: { opencode: 0, claude: 0, kora: 2 } });
});

test('reads skill usage from the OpenCode database and Claude Code transcripts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toonarrow-skills-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('create table part (id text, data text)');
  const insert = db.prepare('insert into part values (?, ?)');
  insert.run('1', JSON.stringify({ type: 'tool', tool: 'skill', state: { input: { id: 'code' } } }));
  insert.run('2', JSON.stringify({ type: 'tool', tool: 'skill', state: { input: { name: 'git-ops' } } }));
  insert.run('3', JSON.stringify({ type: 'tool', tool: 'read', state: { input: { filePath: 'x' } } }));
  db.close();

  const projects = join(dir, 'projects', 'p');
  mkdirSync(projects, { recursive: true });
  const line = (skillName: string): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Skill', input: { skill: skillName } }] } });
  writeFileSync(join(projects, 's.jsonl'), [line('code'), '{"type":"user"}', '{"name":"Skill" broken'].join('\n'));

  const usage: SkillUsage = new Map();
  await readOpencodeUsage(dbPath, usage);
  await readClaudeUsage(join(dir, 'projects'), usage);
  assert.deepEqual(Object.fromEntries(usage), { code: { opencode: 1, claude: 1, kora: 0 }, 'git-ops': { opencode: 1, claude: 0, kora: 0 } });
});
