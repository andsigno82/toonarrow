import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressBashOutput, dedupeRuns, isCompound, normalize, parseCommand, ruleTarget, splitChain } from '../src/compress/shell/index.ts';

const rep = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const body = (text: string): string => text.slice(0, text.lastIndexOf('\n[toonarrow '));

test('compound commands are recognised', () => {
  for (const c of ['ls | head', 'cd x && ls -la', 'ls > out', 'echo $(pwd)', 'a; b', 'ls `pwd`']) assert.equal(isCompound(c), true, c);
  for (const c of ['ls -la', "grep -rn 'a|b' src", 'git log --format="%h|%s"']) assert.equal(isCompound(c), false, c);
});

test('`| cat` is the escape hatch and is never compressed', () => {
  const big = rep(50, (i) => `-rw-r--r--  1 u  staff  ${i}  1 gen 10:00 f${i}`);
  assert.deepEqual(compressBashOutput('ls -la | cat', big), { text: big, rule: 'raw-requested', applied: false });
  assert.equal(compressBashOutput('(cd x && ls -la) | cat ', big).rule, 'raw-requested');
});

test('splitChain splits on top-level && and ; only', () => {
  assert.deepEqual(splitChain('cd "a && b" && git status; echo \'x;y\''), ['cd "a && b"', 'git status', "echo 'x;y'"]);
  assert.deepEqual(splitChain('a || b | c'), ['a || b | c']);
  assert.deepEqual(splitChain('echo a\\;b'), ['echo a\\;b']);
});

test('ruleTarget skips setup steps and keeps ambiguous chains generic', () => {
  assert.equal(ruleTarget('cd /repo && git status'), 'git status');
  assert.equal(ruleTarget('source .venv/bin/activate && cd app && pytest -q 2>&1'), 'pytest -q');
  assert.equal(ruleTarget('export CI=1; set -e; npx vitest run'), 'npx vitest run');
  assert.equal(ruleTarget('source ~/.nvm/nvm.sh && nvm use 24 && npm test'), 'npm test');
  assert.equal(ruleTarget('git status'), 'git status');
  for (const c of ['cd - && ls -la', 'git add . && git status', 'cd x && git diff | head -50', 'for f in *; do wc -l $f; done', 'cd x || exit 1']) {
    assert.equal(ruleTarget(c), undefined, c);
  }
});

test('setup chains use the command rules; other compound output only gets the lossless cleanup', () => {
  const status = [
    'On branch main',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    ...Array.from({ length: 4 }, (_, i) => `\tmodified:   f${i}.ts`),
    ...Array.from({ length: 30 }, () => '  (use "git add <file>..." to include in what will be committed)'),
  ].join('\n');
  const r = compressBashOutput('cd /repo && git status', status);
  assert.equal(r.rule, 'git-status');
  assert.ok(r.text.endsWith('piped through `| cat`]') === false && r.text.endsWith('wrapped as `( … ) | cat`]'));
  const listing = rep(40, (i) => `-rw-r--r--  1 u  staff  ${i}  1 gen 10:00 f${i}`) + '\n' + rep(10, () => 'same line');
  const g = compressBashOutput('ls -la | grep f', listing);
  assert.equal(g.rule, 'generic:low-gain');
  const dup = rep(40, () => 'retrying connection to localhost:5432');
  const d = compressBashOutput('for i in 1 2; do ./probe; done', dup);
  assert.equal(d.rule, 'generic');
  assert.ok(d.text.startsWith('retrying connection to localhost:5432  (×40)\n'));
});

test('parseCommand skips env assignments and runner prefixes', () => {
  assert.deepEqual(parseCommand('CI=1 npx vitest run'), { prog: 'vitest', sub: 'run', args: ['run'] });
  assert.deepEqual(parseCommand('/usr/bin/git -C repo status'), { prog: 'git', sub: 'status', args: ['-C', 'repo', 'status'] });
  assert.equal(parseCommand('git -c core.pager=cat log -n 3').sub, 'log');
  assert.equal(parseCommand('uv run pytest -q').prog, 'pytest');
});

test('normalize strips ANSI and carriage-return redraws; dedupeRuns collapses repeats', () => {
  assert.deepEqual(normalize('\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\n\n'), ['ok', '100%']);
  assert.deepEqual(dedupeRuns(['a', 'a', 'a', 'b', '', '', 'c', 'c']), ['a  (×3)', 'b', '', 'c', 'c']);
});

test('short outputs and low-gain rewrites pass through untouched', () => {
  assert.equal(compressBashOutput('ls -la', 'total 0\n-rw-r--r-- 1 u g 0 1 gen 10:00 a').rule, 'short');
  const plain = rep(30, (i) => `unique line number ${i} with distinct content`);
  const r = compressBashOutput('cat notes.txt', plain);
  assert.equal(r.applied, false);
  assert.equal(r.text, plain);
});

test('ls -la keeps names, types and sizes only', () => {
  const out = [
    'total 2048',
    'drwxr-xr-x  12 andrea  staff   384 24 set 09:10 .',
    'drwxr-xr-x   5 andrea  staff   160 24 set 09:10 ..',
    ...Array.from({ length: 20 }, (_, i) => `-rw-r--r--@  1 andrea  staff  ${13178 + i} 24 set 09:10 file ${i}.ts`),
    'drwxr-xr-x   4 andrea  staff   128 Oct 24 09:10 src',
    'lrwxr-xr-x   1 andrea  staff    33 Oct 24  2025 docs -> /Users/andrea/dev/docs',
  ].join('\n');
  const r = compressBashOutput('ls -la', out);
  assert.equal(r.rule, 'ls-long');
  const lines = body(r.text).split('\n');
  assert.equal(lines[0], 'file 0.ts  13K');
  assert.ok(lines.includes('src/'));
  assert.ok(lines.includes('docs -> /Users/andrea/dev/docs'));
  assert.ok(!lines.some((l) => l.startsWith('total') || l === './' || l === '../'));
});

test('git log collapses headers to one line per commit and keeps stats', () => {
  const commit = (i: number) =>
    [
      `commit ${String(i).padStart(2, '0').repeat(20)}`,
      'Author: Andrea Rossi <a@example.com>',
      'Date:   Thu Oct 29 11:14:26 2026 +0100',
      '',
      `    feat: change number ${i}`,
      '',
      '    Longer explanation line.',
      '',
      '    Co-Authored-By: Bot <bot@example.com>',
      '',
      ` src/f${i}.ts | 3 ++-`,
      ' 1 file changed, 2 insertions(+), 1 deletion(-)',
      '',
    ].join('\n');
  const r = compressBashOutput('git log --stat -n 6', rep(6, commit));
  assert.equal(r.rule, 'git-log');
  const lines = body(r.text).split('\n');
  assert.equal(lines[0], '0000000000 2026-10-29 Andrea Rossi: feat: change number 0');
  assert.equal(lines[1], '  Longer explanation line.');
  assert.equal(lines[2], ' src/f0.ts | 3 ++-');
  assert.ok(!r.text.includes('Co-Authored-By'));
});

test('git log with patches is left alone', () => {
  const out = rep(20, (i) => `commit ${'a'.repeat(40)}\nAuthor: x <x@y>\nDate:   Thu Oct 29 2026\n\n    m${i}\n\ndiff --git a/x b/x`);
  assert.notEqual(compressBashOutput('git log -p', out).rule, 'git-log');
});

test('git status drops hint lines', () => {
  const out = [
    'On branch main',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    ...Array.from({ length: 12 }, (_, i) => `\tmodified:   src/some/deep/path/file-${i}.ts`),
    '',
    'Untracked files:',
    '  (use "git add <file>..." to include in what will be committed)',
    '\tnotes.md',
    '',
    'no changes added to commit (use "git add" and/or "git commit -a")',
  ].join('\n');
  const r = compressBashOutput('git status', out);
  // Hints alone are not worth 20%: the gate keeps the original.
  assert.equal(r.rule, 'git-status:low-gain');
});

test('grep -rn groups by file and factors the common directory', () => {
  const out = rep(30, (i) => `src/components/chat-panel/File${i % 3}.tsx:${i + 1}:  const value = useChat(${i})`);
  const r = compressBashOutput('grep -rn useChat src', out);
  assert.equal(r.rule, 'grep');
  const lines = body(r.text).split('\n');
  assert.equal(lines[0], '# paths below are relative to src/components/chat-panel/');
  assert.equal(lines[1], 'File0.tsx:');
  assert.equal(lines[2], '  1: const value = useChat(0)');
});

test('grep caps matches per file and centres long lines on the pattern', () => {
  const long = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
  const out = rep(25, (i) => `src/big.ts:${i + 1}:${long}`);
  const lines = body(compressBashOutput('grep -rn needle src', out).text).split('\n');
  assert.equal(lines.filter((l) => l.startsWith('  ') && !l.includes('more in this file')).length, 10);
  assert.ok(lines.includes('  … +15 more in this file (narrow the search to see them)'));
  const first = lines.find((l) => l.startsWith('  1: '))!;
  assert.ok(first.includes('needle'));
  assert.ok(first.length < 180);
});

test('grep keeps dashed paths intact', () => {
  const out = rep(20, (i) => `src/a-1-b/x-2.ts:${i + 10}:hit ${i}`);
  const lines = body(compressBashOutput('rg -n hit', out).text).split('\n');
  assert.ok(lines.includes('x-2.ts:') || lines.includes('src/a-1-b/x-2.ts:'));
  assert.ok(lines.includes('  10: hit 0'));
});

test('pytest keeps the summary and failures only', () => {
  const out = [
    '============================= test session starts ==============================',
    'platform darwin -- Python 3.12.1, pytest-8.3.2',
    'collected 120 items',
    '',
    ...Array.from({ length: 12 }, (_, i) => `tests/test_m${i}.py ..........                         [ ${(i + 1) * 8}%]`),
    '=================================== FAILURES ===================================',
    '___________________________________ test_add ___________________________________',
    '>       assert 1 + 2 == 4',
    'E       assert (1 + 2) == 4',
    'tests/test_bad.py:2: AssertionError',
    '======================== 1 failed, 120 passed in 3.21s =========================',
  ].join('\n');
  const r = compressBashOutput('pytest', out);
  assert.equal(r.rule, 'pytest');
  const lines = body(r.text).split('\n');
  assert.equal(lines[0], 'pytest: 1 failed, 120 passed in 3.21s');
  assert.ok(lines.includes('E       assert (1 + 2) == 4'));
  assert.ok(!lines.some((l) => l.includes('[ 8%]')));
});

test('vitest drops passing lines', () => {
  const out = [' RUN  v3.2.4 /repo', '', ...Array.from({ length: 40 }, (_, i) => ` ✓ src/mod${i}.test.ts (3 tests) 10ms`), ' × bad > adds 5ms', '', ' Test Files  1 failed | 40 passed (41)', '      Tests  1 failed | 160 passed (161)'].join('\n');
  const r = compressBashOutput('npm test', out);
  assert.equal(r.rule, 'js-tests');
  assert.ok(r.text.includes('# 40 passing lines omitted'));
  assert.ok(r.text.includes(' × bad > adds 5ms'));
});

test('tsc groups diagnostics by file', () => {
  const out = rep(30, (i) => `src/components/chat/panels/ChatPanel${Math.floor(i / 6)}.tsx(${i + 10},5): error TS2322: Type 'string' is not assignable to type 'number'.`) + '\n\nFound 30 errors in 5 files.';
  const r = compressBashOutput('npx tsc --noEmit', out);
  assert.equal(r.rule, 'tsc');
  const lines = body(r.text).split('\n');
  assert.equal(lines[0], 'src/components/chat/panels/ChatPanel0.tsx:');
  assert.equal(lines[1], "  10:5 TS2322 Type 'string' is not assignable to type 'number'.");
});

test('pip, cargo, go test, make, npm install drop progress noise', () => {
  const pipOut = rep(20, (i) => `Collecting pkg${i}==1.0\n  Downloading pkg${i}-1.0-py3-none-any.whl (10 kB)`) + '\nSuccessfully installed pkg0-1.0';
  assert.equal(compressBashOutput('pip install -r requirements.txt', pipOut).rule, 'pip');
  const cargoOut = rep(40, (i) => `   Compiling crate${i} v0.1.0`) + '\nerror[E0308]: mismatched types\n --> src/main.rs:4:18';
  const cargo = compressBashOutput('cargo build', cargoOut);
  assert.equal(cargo.rule, 'cargo');
  assert.ok(cargo.text.includes('error[E0308]: mismatched types'));
  const goOut = rep(30, (i) => `ok  \tgithub.com/x/app/pkg${i}\t0.01s`) + '\n--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3 want 4\nFAIL';
  const go = compressBashOutput('go test ./...', goOut);
  assert.equal(go.rule, 'go-test');
  assert.ok(go.text.startsWith('go test: 30 packages ok'));
  const makeOut = rep(40, (i) => `cc -O2 -c src/f${i}.c -o build/f${i}.o`) + '\nld build/*.o -o app';
  assert.equal(compressBashOutput('make', makeOut).rule, 'make');
  const npmOut = rep(20, (i) => `npm warn deprecated pkg${i}@1.0.0: this package is no longer supported`) + '\n\nadded 812 packages in 14s';
  assert.equal(compressBashOutput('npm install', npmOut).rule, 'js-install');
});

test('compression is deterministic', () => {
  const out = rep(40, (i) => `src/x/File${i % 4}.ts:${i}:needle ${i}`);
  assert.equal(compressBashOutput('grep -rn needle src', out).text, compressBashOutput('grep -rn needle src', out).text);
});

test('git diff keeps hunks byte for byte and drops only redundant header lines', () => {
  const file = (name: string): string[] => [
    `diff --git a/${name} b/${name}`,
    'index 0123abc..4567def 100644',
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -1,4 +1,4 @@',
    ' a',
    ' ',
    '-b\t',
    '+b  ',
    ' c',
  ];
  const added = ['diff --git a/new.ts b/new.ts', 'new file mode 100644', 'index 0000000..89abcde', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+x'];
  const renamed = ['diff --git a/old name.ts b/new name.ts', 'similarity index 90%', 'rename from old name.ts', 'rename to new name.ts', 'index 1111111..2222222 100644', '--- a/old name.ts', '+++ b/new name.ts', '@@ -1 +1 @@', '-y', '+z'];
  const out = [...file('a.ts'), ...file('b.ts'), ...added, ...renamed].join('\n');
  const r = compressBashOutput('git diff', out);
  assert.equal(r.rule, 'git-diff');
  assert.equal(
    body(r.text),
    [
      'diff --git a/a.ts b/a.ts', '@@ -1,4 +1,4 @@', ' a', ' ', '-b\t', '+b  ', ' c',
      'diff --git a/b.ts b/b.ts', '@@ -1,4 +1,4 @@', ' a', ' ', '-b\t', '+b  ', ' c',
      'diff --git a/new.ts b/new.ts', 'new file mode 100644', '@@ -0,0 +1 @@', '+x',
      'diff --git a/old name.ts b/new name.ts', 'similarity index 90%', 'rename from old name.ts', 'rename to new name.ts', '@@ -1 +1 @@', '-y', '+z',
    ].join('\n'),
  );
});

test('a diff with nothing to drop is passed through, never given the whitespace-trimming generic cleanup', () => {
  const out = ['diff --git a/x b/x', '@@ -1,12 +1,12 @@', ...Array.from({ length: 12 }, () => '+same line  ')].join('\n');
  assert.deepEqual(compressBashOutput('git diff', out), { text: out, rule: 'git-diff:unchanged', applied: false });
});
