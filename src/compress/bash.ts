/**
 * Deterministic, rule-based compression of shell command output.
 *
 * Determinism is a hard requirement: the proxy rewrites every request, so the same tool output
 * must compress to the same bytes each time or the prompt-cache prefix breaks.
 */

export interface BashCompression {
  text: string;
  rule: string;
  applied: boolean;
}

export interface Cmd {
  prog: string;
  sub: string;
  args: string[];
}

interface Rule {
  name: string;
  match(cmd: Cmd, out: string): boolean;
  /** Returns null when the rule does not recognise the output after all. */
  apply(lines: string[], cmd: Cmd): string[] | null;
}

const MIN_LINES = 12;
/** Compressed text must be at most this fraction of the original, footer included. */
const MAX_RATIO = 0.8;
const MAX_LINE = 240;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Pipes, chains, redirections and substitutions make the output's origin ambiguous. */
export function isCompound(command: string): boolean {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return /[|;&<>`\n]|\$\(/.test(unquoted);
}

export function parseCommand(command: string): Cmd {
  const tokens = (command.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/s, '$2'));
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  // Runner prefixes do not change what the output looks like.
  while (tokens.length && ['sudo', 'time', 'npx', 'bunx', 'uv', 'poetry'].includes(tokens[0]!)) {
    tokens.shift();
    if (tokens[0] === 'run' || tokens[0] === 'exec') tokens.shift();
  }
  const prog = (tokens[0] ?? '').split('/').pop() ?? '';
  const args = tokens.slice(1);
  // git -C <dir> / -c <key=value> take a value before the subcommand.
  const valued = prog === 'git' ? new Set(['-C', '-c', '--git-dir', '--work-tree']) : new Set<string>();
  let sub = '';
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i]!)) i++;
    else if (!args[i]!.startsWith('-')) {
      sub = args[i]!;
      break;
    }
  }
  return { prog, sub, args };
}

const hasShortFlag = (cmd: Cmd, letter: string): boolean => cmd.args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
const hasArg = (cmd: Cmd, ...names: string[]): boolean => cmd.args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
const truncate = (line: string): string => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…(+${line.length - MAX_LINE} chars)` : line);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lossless cleanup applied to every output: ANSI codes, carriage-return redraws, trailing blanks. */
export function normalize(output: string): string[] {
  const lines = output.replace(ANSI, '').split('\n');
  const out = lines.map((l) => {
    const line = l.replace(/\s+$/, '');
    const cr = line.lastIndexOf('\r');
    return cr >= 0 ? line.slice(cr + 1) : line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Collapses runs of 3+ identical lines and squeezes blank-line runs. */
export function dedupeRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (lines[i] === '') out.push('');
    else if (n >= 3) out.push(`${lines[i]}  (×${n})`);
    else for (let k = 0; k < n; k++) out.push(lines[i]!);
    i = j;
  }
  return out;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G', 'T'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[u]}`;
}

const LS_LONG = /^([-dlcbps])[-rwxsStTlL]{9}[@+.]?\s+\d+\s+\S+\s+\S+\s+(\S+)\s+(?:\S+\s+){3}(.*)$/;

const lsLong: Rule = {
  name: 'ls-long',
  match: (cmd) => cmd.prog === 'ls' && hasShortFlag(cmd, 'l'),
  apply(lines) {
    let entries = 0;
    const out: string[] = [];
    for (const line of lines) {
      if (/^total \d/.test(line)) continue;
      const m = LS_LONG.exec(line);
      if (!m) {
        out.push(line);
        continue;
      }
      const [, type, size, name] = m as unknown as [string, string, string, string];
      if (name === '.' || name === '..') continue;
      entries++;
      if (type === 'd') out.push(`${name}/`);
      else if (type === 'l') out.push(`${name}`);
      else out.push(/^\d+$/.test(size) ? `${name}  ${humanSize(Number(size))}` : `${name}  ${size}`);
    }
    return entries ? out : null;
  },
};

const gitStatus: Rule = {
  name: 'git-status',
  match: (cmd) => cmd.prog === 'git' && cmd.sub === 'status' && !hasArg(cmd, '--porcelain', '-s', '--short'),
  apply: (lines) => lines.filter((l) => !/^\s+\(use "git .*"\)$/.test(l) && !/^\s+\(.*"git .*".*\)$/.test(l)),
};

const gitLog: Rule = {
  name: 'git-log',
  match: (cmd) =>
    cmd.prog === 'git' &&
    cmd.sub === 'log' &&
    !hasArg(cmd, '--oneline', '--format', '--pretty', '-p', '--patch', '--graph') &&
    !cmd.args.some((a) => /^-[a-zA-Z]*p/.test(a) && !a.startsWith('--')),
  apply(lines) {
    const out: string[] = [];
    let i = 0;
    let commits = 0;
    while (i < lines.length) {
      const head = /^commit ([0-9a-f]{40})(.*)$/.exec(lines[i]!);
      if (!head) {
        out.push(lines[i]!);
        i++;
        continue;
      }
      commits++;
      i++;
      let author = '';
      let date = '';
      const extra: string[] = [];
      while (i < lines.length && lines[i] !== '' && !/^commit [0-9a-f]{40}/.test(lines[i]!)) {
        const l = lines[i]!;
        const a = /^Author:\s+(.*?)\s*(?:<[^>]*>)?$/.exec(l);
        const d = /^(?:Author)?Date:\s+(.*)$/.exec(l);
        if (a) author = a[1]!;
        else if (d) date = isoDay(d[1]!);
        else extra.push(l);
        i++;
      }
      if (lines[i] === '') i++;
      const message: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('    ') || lines[i] === '')) {
        if (lines[i] === '' && (i + 1 >= lines.length || !lines[i + 1]!.startsWith('    '))) break;
        message.push(lines[i]!.slice(4));
        i++;
      }
      const body = message.filter((l) => l.trim() && !/^(Co-Authored-By|Signed-off-by|Generated with):?/i.test(l.trim()));
      out.push(`${head[1]!.slice(0, 10)}${head[2]} ${date} ${author}: ${body[0] ?? ''}`.trimEnd());
      for (const l of extra) out.push(`  ${l}`);
      for (const l of body.slice(1)) out.push(`  ${l}`);
      if (lines[i] === '') i++;
    }
    return commits ? out : null;
  },
};

function isoDay(date: string): string {
  const t = Date.parse(date);
  return Number.isNaN(t) ? date : new Date(t).toISOString().slice(0, 10);
}

// Match lines (path:12:text) are tried before context lines (path-12-text): paths often contain '-'.
const GREP_MATCH = /^(.+?)(:)(\d+):(.*)$/;
const GREP_CONTEXT = /^(.+?)(-)(\d+)-(.*)$/;
const grepLine = (l: string): RegExpExecArray | null => GREP_MATCH.exec(l) ?? GREP_CONTEXT.exec(l);

const GREP_WINDOW = 160;
const GREP_PER_FILE = 10;

/** First positional argument of grep/rg (or the value of -e), used to centre long lines on the match. */
function grepPattern(cmd: Cmd): string | undefined {
  const args = cmd.prog === 'git' ? cmd.args.slice(cmd.args.indexOf('grep') + 1) : cmd.args;
  const e = args.indexOf('-e');
  if (e >= 0) return args[e + 1];
  return args.find((a) => !a.startsWith('-'));
}

function windowAround(text: string, pattern: string | undefined, ignoreCase: boolean): string {
  if (text.length <= GREP_WINDOW) return text;
  const literal = pattern && /^[\w .:/-]+$/.test(pattern) ? pattern : undefined;
  const at = literal ? (ignoreCase ? text.toLowerCase().indexOf(literal.toLowerCase()) : text.indexOf(literal)) : -1;
  const start = at > 60 ? Math.min(at - 60, text.length - GREP_WINDOW) : 0;
  const end = start + GREP_WINDOW;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

const grep: Rule = {
  name: 'grep',
  match: (cmd) => ['grep', 'egrep', 'rg', 'ag'].includes(cmd.prog) || (cmd.prog === 'git' && cmd.sub === 'grep'),
  apply(lines, cmd) {
    const parsed = lines.map(grepLine);
    if (parsed.filter(Boolean).length < lines.length * 0.6) return null;
    const paths = parsed.filter((m): m is RegExpExecArray => m !== null).map((m) => m[1]!);
    const prefix = commonDir(paths);
    const pattern = grepPattern(cmd);
    const ignoreCase = hasShortFlag(cmd, 'i');
    const out: string[] = prefix ? [`# paths below are relative to ${prefix}`] : [];
    let current = '';
    let shown = 0;
    let hidden = 0;
    const flushHidden = (): void => {
      if (hidden) out.push(`  … +${hidden} more in this file (narrow the search to see them)`);
      hidden = 0;
    };
    for (let k = 0; k < lines.length; k++) {
      const m = parsed[k];
      if (!m) {
        flushHidden();
        out.push(truncate(lines[k]!));
        current = '';
        continue;
      }
      const path = m[1]!.slice(prefix.length);
      if (path !== current) {
        flushHidden();
        out.push(`${path}:`);
        current = path;
        shown = 0;
      }
      if (shown >= GREP_PER_FILE) {
        hidden++;
        continue;
      }
      shown++;
      out.push(`  ${m[3]}${m[2] === '-' ? '-' : ':'} ${windowAround(m[4]!.trim(), pattern, ignoreCase)}`);
    }
    flushHidden();
    return out;
  },
};

function commonDir(paths: string[]): string {
  if (paths.length < 2) return '';
  let prefix = paths[0]!;
  for (const p of paths) while (!p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const slash = prefix.lastIndexOf('/');
  return slash > 0 ? prefix.slice(0, slash + 1) : '';
}

const findList: Rule = {
  name: 'find',
  match: (cmd) => ['find', 'fd', 'fdfind'].includes(cmd.prog) || (cmd.prog === 'git' && cmd.sub === 'ls-files'),
  apply(lines) {
    if (lines.some((l) => l.includes(': '))) return null;
    const groups = new Map<string, string[]>();
    for (const l of lines) {
      const slash = l.lastIndexOf('/');
      const dir = slash >= 0 ? l.slice(0, slash + 1) : './';
      const list = groups.get(dir) ?? [];
      list.push(l.slice(slash + 1));
      groups.set(dir, list);
    }
    const out = [`# ${plural(lines.length, 'path')} in ${plural(groups.size, 'directory')}; names are relative to the directory line above them`];
    for (const [dir, names] of groups) {
      out.push(dir);
      for (let k = 0; k < names.length; k += 8) out.push(`  ${names.slice(k, k + 8).join('  ')}`);
    }
    return out;
  },
};

const pytest: Rule = {
  name: 'pytest',
  match: (_cmd, out) => /^=+ test session starts =+$/m.test(out),
  apply(lines) {
    const summary = [...lines].reverse().find((l) => /^=+ .*(passed|failed|error|skipped|no tests ran).* =+$/.test(l));
    const start = lines.findIndex((l) => /^=+ (FAILURES|ERRORS) =+$/.test(l));
    const body = start >= 0 ? lines.slice(start, summary ? lines.lastIndexOf(summary) : undefined) : [];
    return [`pytest: ${summary?.replace(/^=+ | =+$/g, '') ?? 'no summary line'}`, ...body];
  },
};

const jsTestRunner: Rule = {
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

const goTest: Rule = {
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

const cargo: Rule = {
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

const tsc: Rule = {
  name: 'tsc',
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

const jsInstall: Rule = {
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

const pip: Rule = {
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

const make: Rule = {
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

const RULES: Rule[] = [pytest, jsTestRunner, tsc, lsLong, gitStatus, gitLog, grep, findList, goTest, cargo, jsInstall, pip, make];

const passthrough = (text: string, rule: string): BashCompression => ({ text, rule, applied: false });

export function compressBashOutput(command: string, output: string): BashCompression {
  if (isCompound(command)) return passthrough(output, 'compound');
  if (output.includes('<persisted-output>')) return passthrough(output, 'persisted');
  if (/\n\[toonarrow [^\n]*\]$/.test(output)) return passthrough(output, 'already-compressed');
  const lines = normalize(output);
  if (lines.length < MIN_LINES) return passthrough(output, 'short');

  const cmd = parseCommand(command);
  let rule = 'generic';
  let result: string[] | null = null;
  for (const r of RULES) {
    if (!r.match(cmd, output)) continue;
    result = r.apply(lines, cmd);
    if (result) {
      rule = r.name;
      break;
    }
  }
  const body = dedupeRuns(result ?? lines).join('\n');
  const text = `${body}\n[toonarrow ${rule}: ${output.length}→${body.length} chars; for raw output rerun the command piped through \`| cat\`]`;
  if (text.length > output.length * MAX_RATIO) return passthrough(output, `${rule}:low-gain`);
  return { text, rule, applied: true };
}
