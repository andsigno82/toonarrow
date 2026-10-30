import { type Rule, plural } from './common.ts';

export const cargo: Rule = {
  name: 'cargo',
  match: (cmd) => cmd.prog === 'cargo',
  apply(lines) {
    let noise = 0;
    const out = lines.filter((l) => {
      const drop = /^\s*(Compiling|Checking|Downloaded|Downloading|Updating|Locking|Adding|Blocking|Fresh|Running) /.test(l) || /^test \S+ \.\.\. ok$/.test(l);
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

export const jsInstall: Rule = {
  name: 'js-install',
  match: (cmd) => ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd.prog) && ['install', 'i', 'add', 'ci', 'update', 'upgrade'].includes(cmd.sub),
  apply(lines) {
    let deprecated = 0;
    const out = lines.filter((l) => {
      if (/^npm warn deprecated |^ WARN  deprecated |^warning .* deprecated/i.test(l)) {
        deprecated++;
        return false;
      }
      return !/^\s*(run `npm fund`|Run `npm audit` for details|To address all issues|  npm audit fix)/.test(l) && l !== '';
    });
    return deprecated ? [`# ${plural(deprecated, 'deprecation warning')} omitted`, ...out] : out;
  },
};

export const pip: Rule = {
  name: 'pip',
  match: (cmd) => (cmd.prog === 'pip' || cmd.prog === 'pip3' || (cmd.prog.startsWith('python') && cmd.args.includes('pip'))) && cmd.args.includes('install'),
  apply(lines) {
    let noise = 0;
    const out = lines.filter((l) => {
      const drop = /^\s*(Collecting|Downloading|Using cached|Requirement already satisfied|Obtaining|Preparing metadata|Building wheel|Created wheel|Stored in directory)\b/.test(l) || /^\s*[━╸╺─]+/.test(l);
      if (drop) noise++;
      return !drop;
    });
    return noise ? [`# ${plural(noise, 'download/progress line')} omitted`, ...out] : null;
  },
};

export const make: Rule = {
  name: 'make',
  match: (cmd) => cmd.prog === 'make' || cmd.prog === 'ninja' || cmd.prog === 'cmake',
  apply(lines) {
    let compiles = 0;
    const out = lines.filter((l) => {
      const drop = /^\s*(\S*\/)?(cc|gcc|g\+\+|c\+\+|clang|clang\+\+)\s.*\s-c\s/.test(l) || /^\[\s*\d+%\] (Building|Linking)/.test(l) || /^\[\d+\/\d+\] /.test(l);
      if (drop) compiles++;
      return !drop;
    });
    return compiles ? [`# ${plural(compiles, 'compile/progress line')} omitted`, ...out] : null;
  },
};
