/**
 * Synthetic shell outputs, at least one per rule, shaped like the tool versions named in `tool`.
 * `signals` are substrings that must survive compression: errors, failing tests, file:line references.
 */
export interface ShellSample {
  name: string;
  /** Rule expected to apply; 'generic' when no command rule should. */
  rule: string;
  tool: string;
  command: string;
  output: string;
  signals: string[];
}

const rep = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n');

export const SHELL_SAMPLES: ShellSample[] = [
  {
    name: 'ls -la',
    rule: 'ls-long',
    tool: 'macOS ls',
    command: 'ls -la',
    output: ['total 2048', 'drwxr-xr-x  12 a  staff   384 24 set 09:10 .', ...Array.from({ length: 20 }, (_, i) => `-rw-r--r--@  1 a  staff  ${13178 + i} 24 set 09:10 file ${i}.ts`)].join('\n'),
    signals: ['file 0.ts', 'file 19.ts'],
  },
  {
    name: 'git status',
    rule: 'git-status',
    tool: 'git 2.50',
    command: 'cd /repo && git status',
    output: ['On branch main', 'Changes not staged for commit:', ...rep(30, () => '  (use "git add <file>..." to update what will be committed)').split('\n'), '\tmodified:   src/a.ts', '\tboth modified:   src/conflict.ts'].join('\n'),
    signals: ['On branch main', 'modified:   src/a.ts', 'both modified:   src/conflict.ts'],
  },
  {
    name: 'git log',
    rule: 'git-log',
    tool: 'git 2.50',
    command: 'git log -n 6',
    output: rep(6, (i) => [`commit ${String(i).padStart(2, '0').repeat(20)}`, 'Author: A <a@example.com>', 'Date:   Thu Oct 29 11:14:26 2026 +0100', '', `    fix: change ${i}`, ''].join('\n')),
    signals: ['fix: change 0', 'fix: change 5'],
  },
  {
    name: 'grep -rn',
    rule: 'grep',
    tool: 'GNU/BSD grep, ripgrep',
    command: 'grep -rn useChat src',
    output: rep(30, (i) => `src/components/chat-panel/File${i % 3}.tsx:${i + 1}:  const value = useChat(${i})`),
    signals: ['File0.tsx:', '1: const value = useChat(0)'],
  },
  {
    name: 'find',
    rule: 'find',
    tool: 'find, fd',
    command: 'find src -name "*.ts"',
    output: rep(40, (i) => `src/module${i % 4}/file${i}.ts`),
    signals: ['src/module0/', 'file0.ts'],
  },
  {
    name: 'pytest',
    rule: 'pytest',
    tool: 'pytest 8.3',
    command: 'source .venv/bin/activate && pytest',
    output: [
      '============================= test session starts ==============================',
      'collected 120 items',
      ...rep(12, (i) => `tests/test_m${i}.py ..........                         [ ${(i + 1) * 8}%]`).split('\n'),
      '=================================== FAILURES ===================================',
      'E       assert (1 + 2) == 4',
      'tests/test_bad.py:2: AssertionError',
      '======================== 1 failed, 120 passed in 3.21s =========================',
    ].join('\n'),
    signals: ['1 failed, 120 passed', 'E       assert (1 + 2) == 4', 'tests/test_bad.py:2: AssertionError'],
  },
  {
    name: 'vitest',
    rule: 'js-tests',
    tool: 'vitest 3.2',
    command: 'npx vitest run',
    output: [' RUN  v3.2.4 /repo', ...rep(40, (i) => ` ✓ src/mod${i}.test.ts (3 tests) 10ms`).split('\n'), ' × bad > adds 5ms', ' Test Files  1 failed | 40 passed (41)'].join('\n'),
    signals: [' × bad > adds 5ms', 'Test Files  1 failed | 40 passed (41)'],
  },
  {
    name: 'go test',
    rule: 'go-test',
    tool: 'go 1.25',
    command: 'go test ./...',
    output: rep(30, (i) => `ok  \tgithub.com/x/app/pkg${i}\t0.01s`) + '\n--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 3 want 4\nFAIL',
    signals: ['--- FAIL: TestAdd', 'add_test.go:9: got 3 want 4'],
  },
  {
    name: 'cargo build',
    rule: 'cargo',
    tool: 'cargo 1.90',
    command: 'cargo build',
    output: rep(40, (i) => `   Compiling crate${i} v0.1.0`) + '\nerror[E0308]: mismatched types\n --> src/main.rs:4:18',
    signals: ['error[E0308]: mismatched types', 'src/main.rs:4:18'],
  },
  {
    name: 'tsc',
    rule: 'tsc',
    tool: 'TypeScript 5.9',
    command: 'npx tsc --noEmit',
    output: rep(30, (i) => `src/panels/Panel${Math.floor(i / 6)}.tsx(${i + 10},5): error TS2322: Type 'string' is not assignable to type 'number'.`) + '\n\nFound 30 errors in 5 files.',
    signals: ['src/panels/Panel0.tsx', 'TS2322', "Type 'string' is not assignable to type 'number'.", 'Found 30 errors in 5 files.'],
  },
  {
    name: 'npm install',
    rule: 'js-install',
    tool: 'npm 11',
    command: 'npm install',
    output: rep(20, (i) => `npm warn deprecated pkg${i}@1.0.0: this package is no longer supported`) + '\n\nadded 812 packages in 14s',
    signals: ['added 812 packages in 14s'],
  },
  {
    name: 'pip install',
    rule: 'pip',
    tool: 'pip 25',
    command: 'pip install -r requirements.txt',
    output: rep(20, (i) => `Collecting pkg${i}==1.0\n  Downloading pkg${i}-1.0-py3-none-any.whl (10 kB)`) + '\nERROR: No matching distribution found for nope==9\nSuccessfully installed pkg0-1.0',
    signals: ['ERROR: No matching distribution found for nope==9', 'Successfully installed pkg0-1.0'],
  },
  {
    name: 'make',
    rule: 'make',
    tool: 'GNU make, cc',
    command: 'make',
    output: rep(40, (i) => `cc -O2 -c src/f${i}.c -o build/f${i}.o`) + '\nsrc/f3.c:12:5: error: use of undeclared identifier \'x\'\nmake: *** [build/f3.o] Error 1',
    signals: ["src/f3.c:12:5: error: use of undeclared identifier 'x'", 'make: *** [build/f3.o] Error 1'],
  },
  {
    name: 'repeated lines in a loop',
    rule: 'generic',
    tool: 'any',
    command: 'for i in 1 2 3; do ./probe; done',
    output: rep(40, () => 'retrying connection to localhost:5432') + '\nerror: connection refused',
    signals: ['retrying connection to localhost:5432', 'error: connection refused'],
  },
];
