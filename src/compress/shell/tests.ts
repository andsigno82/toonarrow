import { type Rule, matchCount, plural } from './common.ts';

export const pytest: Rule = {
  name: 'pytest',
  byFormat: true,
  match: (_cmd, out) => /^=+ test session starts =+$/m.test(out),
  apply(lines) {
    const summary = [...lines].reverse().find((l) => /^=+ .*(passed|failed|error|skipped|no tests ran).* =+$/.test(l));
    const start = lines.findIndex((l) => /^=+ test session starts =+$/.test(l));
    const end = summary ? lines.lastIndexOf(summary) : -1;
    // Only the banner, the progress lines and the summary go: the header restates the summary, and every other
    // line (failures, foreign output in compound commands) is kept byte for byte.
    const out = lines.filter((l, i) => {
      if (i === start || i === end) return false;
      return !(start >= 0 && i > start && i < end && /\[ *\d{1,3}%\] *$/.test(l) && !/FAIL|ERROR/.test(l));
    });
    return [`pytest: ${summary?.replace(/^=+ | =+$/g, '') ?? 'no summary line'}`, ...out];
  },
};

export const jsTestRunner: Rule = {
  name: 'js-tests',
  byFormat: true,
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

// `ok pkg 0.01s`, `? pkg [no test files]`, `=== RUN` and `--- PASS:/--- FAIL:`: the go-test line shapes.
const GO_OK = /^ok\s+\S+\s+([\d.]+s|\(cached\))/;
const GO_LINE = /^(ok\s+\S+\s+([\d.]+s|\(cached\))|\?\s+\S+\s+\[no test files\]|=== (RUN|PAUSE|CONT)\b|\s*--- (PASS|FAIL):)/;

export const goTest: Rule = {
  name: 'go-test',
  byFormat: true,
  match: (cmd, out) => (cmd.prog === 'go' && cmd.sub === 'test') || matchCount(out, GO_LINE) >= 3,
  apply(lines) {
    let ok = 0;
    const out = lines.filter((l) => {
      if (GO_OK.test(l) || /^\?\s+\S+\s+\[no test files\]/.test(l)) {
        ok++;
        return false;
      }
      return !/^(=== (RUN|PAUSE|CONT)\b|\s*--- PASS:)/.test(l);
    });
    return [`go test: ${plural(ok, 'package')} ok or without tests (omitted)`, ...out];
  },
};
