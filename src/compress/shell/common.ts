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
}

export const MAX_LINE = 240;

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

export const hasShortFlag = (cmd: Cmd, letter: string): boolean => cmd.args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
export const hasArg = (cmd: Cmd, ...names: string[]): boolean => cmd.args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
export const truncate = (line: string): string => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…(+${line.length - MAX_LINE} chars)` : line);
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

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
