import { type Rule, matchCount, plural } from './common.ts';

const CARGO_NOISE = /^\s*(Compiling|Checking|Downloaded|Downloading|Updating|Locking|Adding|Blocking|Fresh|Running) |^test \S+ \.\.\. ok$/;
// Format signature keeps only the cargo-distinctive verbs: Downloading/Updating/Adding are also pip's.
const CARGO_FORMAT = /^\s*(Compiling|Checking|Fresh|Locking|Blocking|Running) |^test \S+ \.\.\. ok$/;

export const cargo: Rule = {
  name: 'cargo',
  byFormat: true,
  match: (cmd, out) => cmd.prog === 'cargo' || matchCount(out, CARGO_FORMAT) >= 3,
  apply(lines) {
    let noise = 0;
    const out = lines.filter((l) => {
      const drop = CARGO_NOISE.test(l);
      if (drop) noise++;
      return !drop;
    });
    return noise ? [`# ${plural(noise, 'progress line')} omitted (Compiling/Downloading/passing tests)`, ...out] : null;
  },
};

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export const tsc: Rule = {
  name: 'tsc',
  byFormat: true,
  match: (_cmd, out) => /^.+\(\d+,\d+\): error TS\d+:/m.test(out),
  apply(lines) {
    const out: string[] = [];
    let file = '';
    for (const l of lines) {
      const m = TSC_LINE.exec(l);
      if (!m) {
        out.push(l);
        file = '';
        continue;
      }
      if (m[1] !== file) {
        file = m[1]!;
        out.push(`${file}:`);
      }
      out.push(`  ${m[2]}:${m[3]} ${m[4] === 'error' ? '' : 'warning '}${m[5]} ${m[6]}`);
    }
    return out;
  },
};

const JS_DEPRECATED = /^npm warn deprecated |^ WARN  deprecated |^warning .* deprecated/i;

export const jsInstall: Rule = {
  name: 'js-install',
  byFormat: true,
  match: (cmd, out) => (['npm', 'pnpm', 'yarn', 'bun'].includes(cmd.prog) && ['install', 'i', 'add', 'ci', 'update', 'upgrade'].includes(cmd.sub)) || matchCount(out, JS_DEPRECATED) >= 3,
  apply(lines, cmd) {
    const installer = ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd.prog);
    let deprecated = 0;
    const out = lines.filter((l) => {
      if (JS_DEPRECATED.test(l)) {
        deprecated++;
        return false;
      }
      if (l === '') return !installer;
      return !/^\s*(run `npm fund`|Run `npm audit` for details|To address all issues|  npm audit fix)/.test(l);
    });
    return deprecated ? [`# ${plural(deprecated, 'deprecation warning')} omitted`, ...out] : out;
  },
};

const PIP_NOISE = /^\s*(Collecting|Downloading|Using cached|Requirement already satisfied|Obtaining|Preparing metadata|Building wheel|Created wheel|Stored in directory)\b|^\s*[━╸╺─]+/;

export const pip: Rule = {
  name: 'pip',
  byFormat: true,
  match: (cmd, out) => ((cmd.prog === 'pip' || cmd.prog === 'pip3' || (cmd.prog.startsWith('python') && cmd.args.includes('pip'))) && cmd.args.includes('install')) || matchCount(out, PIP_NOISE) >= 3,
  apply(lines) {
    let noise = 0;
    const out = lines.filter((l) => {
      const drop = PIP_NOISE.test(l);
      if (drop) noise++;
      return !drop;
    });
    return noise ? [`# ${plural(noise, 'download/progress line')} omitted`, ...out] : null;
  },
};

const MAKE_NOISE = /^\s*(\S*\/)?(cc|gcc|g\+\+|c\+\+|clang|clang\+\+)\s.*\s-c\s|^\[\s*\d+%\] (Building|Linking)|^\[\d+\/\d+\] /;

export const make: Rule = {
  name: 'make',
  byFormat: true,
  match: (cmd, out) => ['make', 'ninja', 'cmake'].includes(cmd.prog) || matchCount(out, MAKE_NOISE) >= 3,
  apply(lines) {
    let compiles = 0;
    const out = lines.filter((l) => {
      const drop = MAKE_NOISE.test(l);
      if (drop) compiles++;
      return !drop;
    });
    return compiles ? [`# ${plural(compiles, 'compile/progress line')} omitted`, ...out] : null;
  },
};
