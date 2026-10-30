import { type Rule, plural } from './common.ts';

export const pytest: Rule = {
  name: 'pytest',
  match: (_cmd, out) => /^=+ test session starts =+$/m.test(out),
  apply(lines) {
    const summary = [...lines].reverse().find((l) => /^=+ .*(passed|failed|error|skipped|no tests ran).* =+$/.test(l));
    const start = lines.findIndex((l) => /^=+ (FAILURES|ERRORS) =+$/.test(l));
    const body = start >= 0 ? lines.slice(start, summary ? lines.lastIndexOf(summary) : undefined) : [];
    return [`pytest: ${summary?.replace(/^=+ | =+$/g, '') ?? 'no summary line'}`, ...body];
  },
};

export const jsTestRunner: Rule = {
  name: 'js-tests',
  match: (_cmd, out) => /^\s*(Test Files|Tests:|Test Suites:)\s/m.test(out),
  apply(lines) {
    let passed = 0;
    const out = lines.filter((l) => {
      const pass = /^\s*(✓|√|✔)\s/.test(l) || /^\s*PASS\s/.test(l);
      if (pass) passed++;
      return !pass;
    });
    return passed ? [`# ${plural(passed, 'passing line')} omitted`, ...out] : null;
  },
};

export const goTest: Rule = {
  name: 'go-test',
  match: (cmd) => cmd.prog === 'go' && cmd.sub === 'test',
  apply(lines) {
    let ok = 0;
    const out = lines.filter((l) => {
      if (/^ok\s/.test(l) || /^\?\s+\S+\s+\[no test files\]/.test(l)) {
        ok++;
        return false;
      }
      return !/^(=== (RUN|PAUSE|CONT)|\s*--- PASS:)/.test(l);
    });
    return [`go test: ${plural(ok, 'package')} ok or without tests (omitted)`, ...out];
  },
};
