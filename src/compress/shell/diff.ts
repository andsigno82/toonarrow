import { type Rule } from './common.ts';

/**
 * Unified git diffs (`git diff`, `git show`, `git log -p`, `git stash show -p`), recognised by their format.
 * Lossless: per-file headers keep only the `diff --git` line plus mode, rename and binary lines; the `index`
 * line and `---`/`+++` lines that repeat the header paths go. Hunks, context included, are untouched.
 */
export const gitDiff: Rule = {
  name: 'git-diff',
  byFormat: true,
  verbatim: true,
  maxRatio: 0.97,
  match: (_cmd, out) => /^diff --git a\//m.test(out) && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(out),
  apply(lines) {
    const out: string[] = [];
    let header = '';
    let inHeader = false;
    let dropped = 0;
    for (const l of lines) {
      if (l.startsWith('diff --git a/')) {
        header = l;
        inHeader = true;
        out.push(l);
        continue;
      }
      if (inHeader) {
        if (l.startsWith('@@')) inHeader = false;
        else if (/^index [0-9a-f]+\.\.[0-9a-f]+( \d+)?$/.test(l)) {
          dropped++;
          continue;
        } else if (l === '--- /dev/null' || l === '+++ /dev/null' || (l.startsWith('--- a/') && header.startsWith(`diff --git a/${l.slice(6)} b/`)) || (l.startsWith('+++ b/') && header.endsWith(` b/${l.slice(6)}`))) {
          dropped++;
          continue;
        }
      }
      out.push(l);
    }
    return dropped ? out : null;
  },
};
