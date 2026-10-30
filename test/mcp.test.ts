import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edit } from '../src/mcp/edit.ts';
import { normalizePatterns, search } from '../src/mcp/search.ts';
import { Session } from '../src/mcp/session.ts';

let root: string;
let session: Session;

const SOURCE = [
  "import { x } from './x';",
  '',
  'export class Store {',
  '  get(key: string) {',
  '    return this.map.get(key);',
  '  }',
  '',
  '  set(key: string, value: number) {',
  '    this.map.set(key, value);',
  '  }',
  '}',
  '',
  'export function helper(a: number): number {',
  '  return a + 1;',
  '}',
  '',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toonarrow-mcp-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'src', 'store.ts'), SOURCE);
  writeFileSync(join(root, 'src', 'notes.md'), '# notes\nstore things\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.ts'), 'export const store = 1;\n');
  session = new Session();
});

const read = (patterns: string | string[], extra: object = {}) => search({ patterns: [patterns].flat(), ...extra }, session, root);

test('reads files with line numbers and stubs unchanged re-reads', async () => {
  const first = await read('src/store.ts');
  assert.ok(first.startsWith('src/store.ts (15 lines'));
  assert.ok(first.includes('3\texport class Store {'));
  assert.equal(await read('src/store.ts'), 'src/store.ts#1-15: [unchanged since your last read]');
  const range = await read('src/store.ts#13-14');
  assert.ok(range.includes('13\texport function helper'));
  assert.ok(!range.includes('3\texport class'));
});

test('reads several files in one call', async () => {
  const out = await read(['src/store.ts', 'src/notes.md']);
  assert.ok(out.includes('src/store.ts (15 lines'));
  assert.ok(out.includes('src/notes.md (2 lines'));
});

test('patterns sent as a JSON-encoded string are accepted', async () => {
  assert.deepEqual(normalizePatterns('["src/a.ts", "src/b.ts"]'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(normalizePatterns('src/[ab].ts'), ['src/[ab].ts']);
  assert.deepEqual(normalizePatterns('[ab].ts'), ['[ab].ts']);
  assert.deepEqual(normalizePatterns(['x']), ['x']);
});

test('globs list paths and skip node_modules', async () => {
  const out = await read('**/*.ts');
  assert.equal(out, 'src/store.ts');
});

test('regex search folds unrelated lines and hints the next symbol', async () => {
  const out = await read('src/**/*.ts', { contentRegex: 'map\\.set' });
  const lines = out.split('\n');
  assert.equal(lines[0], 'src/store.ts (1 match, 15 lines):');
  assert.equal(lines[1], '…1-8 [next: export class Store at line 3]');
  assert.equal(lines[2], '9\t    this.map.set(key, value);');
  assert.equal(lines[3], '…10-15 [next: export function helper(a: number): number at line 13]');
});

test('count mode and missing matches', async () => {
  const counts = (await read('src/**/*', { contentRegex: 'store', ignoreCase: true, mode: 'count' })).split('\n');
  assert.equal(counts.pop(), 'total: 2 in 2 file(s)');
  assert.deepEqual(counts.sort(), ['src/notes.md: 1', 'src/store.ts: 1']);
  assert.match(await read('src/**/*.ts', { contentRegex: 'nothing-here' }), /^no matches/);
});

test('summary returns a tree-sitter outline', async () => {
  const out = await read('src/store.ts', { summary: true });
  assert.equal(
    out.replace(/\d+B\)/, 'xB)'),
    ['src/store.ts (15 lines, xB) outline:', '3-11 export class Store', '  4-6 get(key: string)', '  8-10 set(key: string, value: number)', '13-15 export function helper(a: number): number'].join('\n'),
  );
});

test('outline keeps export on arrow-function constants', async () => {
  writeFileSync(join(root, 'src', 'arrow.ts'), 'export const add = (a: number, b: number): number => a + b;\nconst local = () => 1;\n');
  const out = await read('src/arrow.ts', { summary: true });
  assert.ok(out.includes('1-1 export add = (a: number, b: number): number =>'), out);
  assert.ok(out.includes('2-2 local = () =>'), out);
});

test('edit requires a prior read and detects stale files', async () => {
  const blind = await edit([{ file_path: 'src/store.ts', old_string: 'a + 1', new_string: 'a + 2' }], session, root);
  assert.equal(blind.isError, true);
  assert.match(blind.text, /\(not_in_session\)/);

  await read('src/store.ts');
  writeFileSync(join(root, 'src', 'store.ts'), SOURCE.replace('a + 1', 'a + 9'));
  const stale = await edit([{ file_path: 'src/store.ts', old_string: 'a + 9', new_string: 'a + 2' }], session, root);
  assert.match(stale.text, /\(stale\)/);
});

test('edit applies batched replacements and reports the line range', async () => {
  await read('src/store.ts');
  const r = await edit(
    [
      { file_path: 'src/store.ts', old_string: 'return a + 1;', new_string: 'return a + 2;' },
      { file_path: 'src/store.ts', old_string: 'get(key: string) {', new_string: 'get(key: string): number | undefined {' },
    ],
    session,
    root,
  );
  assert.equal(r.isError, false);
  assert.equal(r.text, 'src/store.ts#4-14 (modified, +2 -2 lines)');
  const after = readFileSync(join(root, 'src', 'store.ts'), 'utf8');
  assert.ok(after.includes('return a + 2;') && after.includes('get(key: string): number | undefined {'));
  // Our own write refreshes the session hash: a follow-up edit needs no re-read.
  const again = await edit([{ file_path: 'src/store.ts', old_string: 'a + 2', new_string: 'a + 3' }], session, root);
  assert.equal(again.isError, false);
});

test('ambiguous matches need context, a line scope or replace_all', async () => {
  await read('src/store.ts');
  const amb = await edit([{ file_path: 'src/store.ts', old_string: 'this.map', new_string: 'this.m' }], session, root);
  assert.match(amb.text, /\(ambiguous\)\n  old_string occurs 2 times \(lines 5, 9\)/);
  const scoped = await edit([{ file_path: 'src/store.ts#8-10', old_string: 'this.map', new_string: 'this.m' }], session, root);
  assert.equal(scoped.text, 'src/store.ts#9-9 (modified, +1 -1 lines)');
  const all = await edit([{ file_path: 'src/store.ts', old_string: 'this.', new_string: 'self.', replace_all: true }], session, root);
  assert.equal(all.isError, false);
  assert.equal(readFileSync(join(root, 'src', 'store.ts'), 'utf8').includes('this.'), false);
});

test('tolerant matching for trailing whitespace and typographic quotes; helpful not_found', async () => {
  writeFileSync(join(root, 'src', 'q.ts'), "const s = 'hello';   \nconst t = 1;\n");
  await read('src/q.ts');
  const r = await edit([{ file_path: 'src/q.ts', old_string: 'const s = ‘hello’;\nconst t = 1;', new_string: "const s = 'hi';\nconst t = 1;" }], session, root);
  assert.match(r.text, /matched ignoring trailing whitespace\/quote style/);
  assert.equal(readFileSync(join(root, 'src', 'q.ts'), 'utf8'), "const s = 'hi';\nconst t = 1;\n");
  const nf = await edit([{ file_path: 'src/q.ts', old_string: 'const t = 2;', new_string: 'x' }], session, root);
  assert.match(nf.text, /\(not_found\)/);
});

test('create, refuse to clobber, overwrite after reading; CRLF preserved', async () => {
  const created = await edit([{ file_path: 'src/new/a.ts', new_string: 'export const a = 1;\n' }], session, root);
  assert.equal(created.text, 'src/new/a.ts (created, 1 lines)');
  const clobber = await edit([{ file_path: 'src/store.ts', new_string: 'x' }], session, root);
  assert.match(clobber.text, /\(create_exists\)/);
  writeFileSync(join(root, 'src', 'win.ts'), 'a\r\nb\r\n');
  await read('src/win.ts');
  await edit([{ file_path: 'src/win.ts', old_string: 'a\nb', new_string: 'a\nc' }], session, root);
  assert.equal(readFileSync(join(root, 'src', 'win.ts'), 'utf8'), 'a\r\nc\r\n');
});

test('files are atomic and independent within one call', async () => {
  await read(['src/store.ts', 'src/notes.md']);
  const r = await edit(
    [
      { file_path: 'src/notes.md', old_string: 'store things', new_string: 'keep things' },
      { file_path: 'src/store.ts', old_string: 'return a + 1;', new_string: 'return a + 5;' },
      { file_path: 'src/store.ts', old_string: 'does not exist', new_string: 'x' },
    ],
    session,
    root,
  );
  assert.equal(r.isError, false);
  assert.match(r.text, /1 applied · 1 failed\./);
  assert.ok(readFileSync(join(root, 'src', 'notes.md'), 'utf8').includes('keep things'));
  assert.ok(readFileSync(join(root, 'src', 'store.ts'), 'utf8').includes('return a + 1;'), 'failed file left untouched');
});
