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
 * `source`/`.` of an environment script. `nvm use` prints one line, which the rules tolerate. A failing step stops an
 * `&&` chain with a short error that no rule matches.
 */
function isSetupStep(step: string): boolean {
  if (isCompound(step)) return false;
  const tokens = step.split(/\s+/);
  const [prog, first] = tokens;
  if (prog === 'cd') return tokens.length === 2 && first !== '-';
  if (prog === 'nvm') return first === 'use';
  return ['export', 'set', 'unset', 'source', '.', 'ulimit', 'umask'].includes(prog!);
}

/**
 * The command whose output the rules may parse: the last step of a chain whose other steps are setup, with a
 * trailing `2>&1` dropped. Undefined when the output's origin is ambiguous (pipes, loops, several real commands):
 * such output still gets the lossless generic cleanup, never a command-specific rule.
 */
export function ruleTarget(command: string): string | undefined {
  const steps = splitChain(command);
  const last = steps.pop()?.replace(/\s+2>&1$/, '');
  if (last === undefined || !steps.every(isSetupStep) || isCompound(last)) return undefined;
  return last;
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
