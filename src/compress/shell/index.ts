/** Deterministic, rule-based compression of shell command output: the rule registry and its entry point. */
import { type BashCompression, type Rule, dedupeRuns, isCompound, normalize, parseCommand, ruleTarget } from './common.ts';
import { cargo, jsInstall, make, pip, tsc } from './build.ts';
import { findList, grep, lsLong } from './files.ts';
import { gitLog, gitStatus } from './git.ts';
import { goTest, jsTestRunner, pytest } from './tests.ts';

export { type BashCompression, type Cmd, dedupeRuns, isCompound, normalize, parseCommand, ruleTarget, splitChain } from './common.ts';

const MIN_LINES = 12;
/** Compressed text must be at most this fraction of the original, footer included. */
const MAX_RATIO = 0.8;

/** Output-signature rules come first: they recognise the tool whatever wrapper ran it. */
const RULES: Rule[] = [pytest, jsTestRunner, tsc, lsLong, gitStatus, gitLog, grep, findList, goTest, cargo, jsInstall, pip, make];

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
  let rule = 'generic';
  let result: string[] | null = null;
  if (target !== undefined) {
    const cmd = parseCommand(target);
    for (const r of RULES) {
      if (!r.match(cmd, output)) continue;
      result = r.apply(lines, cmd);
      if (result) {
        rule = r.name;
        break;
      }
    }
  }
  const hatch = isCompound(command) ? 'wrapped as `( … ) | cat`' : 'piped through `| cat`';
  const body = dedupeRuns(result ?? lines).join('\n');
  const text = `${body}\n[toonarrow ${rule}: ${output.length}→${body.length} chars; for raw output rerun the command ${hatch}]`;
  if (text.length > output.length * MAX_RATIO) return passthrough(output, `${rule}:low-gain`);
  return { text, rule, applied: true };
}
