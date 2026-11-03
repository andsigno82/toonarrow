/**
 * Shared types and helpers of the shell-output rules.
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

export interface Rule {
  name: string;
  match(cmd: Cmd, out: string): boolean;
  /** Returns null when the rule does not recognise the output after all. */
  apply(lines: string[], cmd: Cmd): string[] | null;
  /**
   * Recognised by the output format alone and rewrites only lines of that format: safe on output whose origin is
   * ambiguous (pipes, several commands). Such rules match an empty Cmd there.
   */
  byFormat?: boolean;
  /**
   * Whitespace and repeated lines are content (diffs): the rule gets the output split on newlines with only ANSI
   * codes removed, and its result is not deduplicated.
   */
  verbatim?: boolean;
  /** Gate for this rule's gain (default MAX_RATIO): lossless rules can accept a smaller gain. */
  maxRatio?: number;
}

export const MAX_LINE = 240;

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** Pipes, chains, redirections and substitutions make the output's origin ambiguous. */
export function isCompound(command: string): boolean {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return /[|;&<>`\n]|\$\(/.test(unquoted);
}

/** Top-level `&&` and `;` segments of a command line; quotes and backslash escapes are respected. */
export function splitChain(command: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\' && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === ';' || (c === '&' && command[i + 1] === '&')) {
      parts.push(command.slice(start, i).trim());
      if (c === '&') i++;
      start = i + 1;
    }
  }
  parts.push(command.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Chain steps that print nothing on success, so the output is the last command's: `cd dir`, `export`, `set`, `unset`,
 * `source`/`.` of an environment script, variable assignments. `nvm use` prints one line, which the rules tolerate.
 * A failing step stops an `&&` chain with a short error that no rule matches.
 */
function isSetupStep(step: string): boolean {
  if (isCompound(step)) return false;
  const tokens = step.split(/\s+/);
  const [prog, first] = tokens;
  if (tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t))) return true;
  if (prog === 'cd') return tokens.length === 2 && first !== '-';
  if (prog === 'nvm') return first === 'use';
  return ['export', 'set', 'unset', 'source', '.', 'ulimit', 'umask'].includes(prog!);
}

/** Top-level `|` segments of a step; `||` stays inside a segment. Quotes and backslash escapes are respected. */
export function splitPipe(step: string): string[] {
  const parts: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < step.length; i++) {
    const c = step[i]!;
    if (c === '\\' && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '|' && step[i + 1] !== '|' && step[i - 1] !== '|') {
      parts.push(step.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(step.slice(start).trim());
  return parts.filter(Boolean);
}

/** Attached output redirections (`2>&1`, `>f`, `&>f`) are dropped when deciding which command produced the output. */
const stripRedirections = (step: string): string => step.replace(/(^|\s)(?:\d?>>?|&>)\S+/g, '$1').trim();

/**
 * Options of a line filter that only select, limit or reorder whole lines. `flags` are bare short options, `valued`
 * short options take a value (attached or as the next token), `long` matches the allowed long options. `operands` is
 * how many operands may follow: grep's pattern (none when -e/-f supply it), Infinity for `tee`'s output files.
 */
interface FilterSpec {
  flags: string;
  valued: string;
  long: RegExp;
  operands: number;
}

const HEAD_TAIL: FilterSpec = { flags: 'qs', valued: 'n', long: /^--(lines=|quiet$|silent$)/, operands: 0 };
const GREP: FilterSpec = {
  flags: 'vihsEFGPwxyaI',
  valued: 'emf',
  long: /^--(invert-match|ignore-case|no-ignore-case|extended-regexp|fixed-strings|basic-regexp|perl-regexp|word-regexp|line-regexp|no-messages|text|colou?r=never|regexp=|max-count=|file=)/,
  operands: 1,
};

// A whitelist, not a blacklist: any other option may rewrite the lines (grep -n/-H/-b/-A/-o/--color, head -c,
// uniq -c, cat -n, sort -o), and an extra operand makes the filter read a file instead of the pipe. Such a pipeline
// has an ambiguous origin, so it only gets the byFormat rules.
const LINE_FILTERS: Record<string, FilterSpec> = {
  head: HEAD_TAIL,
  tail: { ...HEAD_TAIL, flags: 'qsfFr' },
  sort: {
    flags: 'bdfghiMnRrsuV',
    valued: 'ktS',
    long: /^--(key=|field-separator=|buffer-size=|ignore-leading-blanks$|dictionary-order$|ignore-case$|general-numeric-sort$|human-numeric-sort$|month-sort$|numeric-sort$|random-sort$|reverse$|stable$|unique$|version-sort$)/,
    operands: 0,
  },
  uniq: { flags: 'diuD', valued: 'fs', long: /^--(repeated$|unique$|ignore-case$|all-repeated(=|$)|skip-fields=|skip-chars=)/, operands: 0 },
  cat: { flags: '', valued: '', long: /^$/, operands: 0 },
  tee: { flags: 'aip', valued: '', long: /^--(append$|ignore-interrupts$)/, operands: Infinity },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    ...GREP,
    flags: 'vihsSwxFPaI',
    long: /^--(invert-match|ignore-case|smart-case|case-sensitive|word-regexp|line-regexp|fixed-strings|pcre2|no-messages|text|no-line-number|colou?r=never|regexp=|max-count=|file=)/,
  },
};

/** A pipeline segment after the producer that passes some of its lines through unchanged, possibly reordered. */
function isLineFilter(step: string): boolean {
  // `|&` pipes stderr too; a quoted operand stays one token.
  const tokens = stripRedirections(step.replace(/^&\s*/, '')).match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  const prog = (tokens[0] ?? '').split('/').pop() ?? '';
  const spec = LINE_FILTERS[prog];
  if (!spec) return false;
  let operands = 0;
  let patternGiven = false;
  let options = true;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!options || t === '-' || !t.startsWith('-')) operands++;
    else if (t === '--') options = false;
    else if (t.startsWith('--')) {
      if (!spec.long.test(t)) return false;
      if (/^--(regexp|file)=/.test(t)) patternGiven = true;
    } else if (/^-\d+$/.test(t) && (prog === 'head' || prog === 'tail')) continue; // `head -20`
    else {
      for (let j = 1; j < t.length; j++) {
        const c = t[j]!;
        if (spec.valued.includes(c)) {
          if (spec.operands === 1 && (c === 'e' || c === 'f')) patternGiven = true;
          if (j === t.length - 1) i++; // the value is the next token
          break;
        }
        if (!spec.flags.includes(c)) return false;
      }
    }
  }
  return operands <= (patternGiven ? spec.operands - 1 : spec.operands);
}

/**
 * The command whose output the rules may parse: the first segment of the last chain step when the rest of the
 * pipeline only selects lines (`head`, `sort`, `uniq`, plain `grep`…), with setup steps and redirections ignored.
 * Undefined when the output's origin is ambiguous (loops, several real commands, rewriting filters): such output
 * still gets the lossless generic cleanup and the byFormat rules, never a command-specific rule.
 */
export function ruleTarget(command: string): string | undefined {
  const steps = splitChain(command);
  const last = steps.pop();
  if (last === undefined || !steps.every(isSetupStep)) return undefined;
  const [producer, ...filters] = splitPipe(last);
  if (producer === undefined || !filters.every(isLineFilter)) return undefined;
  const target = stripRedirections(producer);
  return target === '' || isCompound(target) ? undefined : target;
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

export const hasShortFlag = (cmd: Cmd, letter: string): boolean => cmd.args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
/** Lines matching `re`: the output signature a byFormat rule checks before rewriting. */
export const matchCount = (out: string, re: RegExp): number => out.split('\n').reduce((n, l) => n + (re.test(l) ? 1 : 0), 0);
export const hasArg = (cmd: Cmd, ...names: string[]): boolean => cmd.args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
export const truncate = (line: string): string => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…(+${line.length - MAX_LINE} chars)` : line);
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lossless cleanup applied to every output: ANSI codes, carriage-return redraws, trailing blanks. */
export function normalize(output: string): string[] {
  const lines = stripAnsi(output).split('\n');
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

export function humanSize(bytes: number): string {
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
