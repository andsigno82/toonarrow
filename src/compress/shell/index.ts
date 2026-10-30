/** Deterministic, rule-based compression of shell command output: the rule registry and its entry point. */
import { type BashCompression, type Cmd, type Rule, dedupeRuns, isCompound, normalize, parseCommand, ruleTarget, stripAnsi } from './common.ts';
import { gitDiff } from './diff.ts';
import { cargo, jsInstall, make, pip, tsc } from './build.ts';
import { findList, grep, lsLong } from './files.ts';
import { gitLog, gitStatus } from './git.ts';
import { goTest, jsTestRunner, pytest } from './tests.ts';

export { type BashCompression, type Cmd, dedupeRuns, isCompound, normalize, parseCommand, ruleTarget, splitChain } from './common.ts';

const MIN_LINES = 12;
/** Compressed text must be at most this fraction of the original, footer included. */
const MAX_RATIO = 0.8;

/** Output-signature rules come first: they recognise the tool whatever wrapper ran it. */
const RULES: Rule[] = [gitDiff, pytest, jsTestRunner, tsc, lsLong, gitStatus, gitLog, grep, findList, goTest, cargo, jsInstall, pip, make];

const NO_CMD: Cmd = { prog: '', sub: '', args: [] };

export const RULE_NAMES: readonly string[] = RULES.map((r) => r.name);

const passthrough = (text: string, rule: string): BashCompression => ({ text, rule, applied: false });

export function compressBashOutput(command: string, output: string): BashCompression {
  // `| cat` is the escape hatch every footer points to: its output is never touched.
  if (/\|\s*cat\s*$/.test(command.trim())) return passthrough(output, 'raw-requested');
  if (output.includes('<persisted-output>')) return passthrough(output, 'persisted');
  if (/\n\[toonarrow [^\n]*\]$/.test(output)) return passthrough(output, 'already-compressed');
  const lines = normalize(output);
  if (lines.length < MIN_LINES) return passthrough(output, 'short');

  const target = ruleTarget(command);
  // Ambiguous origin (pipes, several commands): only rules that work on the output format alone.
  const cmd = target === undefined ? NO_CMD : parseCommand(target);
  let chosen: Rule | undefined;
  let result: string[] | null = null;
  for (const r of RULES) {
    if ((target === undefined && !r.byFormat) || !r.match(cmd, output)) continue;
    result = r.apply(r.verbatim ? stripAnsi(output).split('\n') : lines, cmd);
    if (result) {
      chosen = r;
      break;
    }
    // Whitespace-sensitive output the rule declined (a diff with nothing to drop) must not get the generic cleanup.
    if (r.verbatim) return passthrough(output, `${r.name}:unchanged`);
  }
  const rule = chosen?.name ?? 'generic';
  const hatch = isCompound(command) ? 'wrapped as `( … ) | cat`' : 'piped through `| cat`';
  const body = (chosen?.verbatim ? result! : dedupeRuns(result ?? lines)).join('\n').replace(/\n+$/, '');
  const text = `${body}\n[toonarrow ${rule}: ${output.length}→${body.length} chars; for raw output rerun the command ${hatch}]`;
  if (text.length > output.length * (chosen?.maxRatio ?? MAX_RATIO)) return passthrough(output, `${rule}:low-gain`);
  return { text, rule, applied: true };
}
