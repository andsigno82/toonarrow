import { type Rule, hasArg } from './common.ts';

export const gitStatus: Rule = {
  name: 'git-status',
  match: (cmd) => cmd.prog === 'git' && cmd.sub === 'status' && !hasArg(cmd, '--porcelain', '-s', '--short'),
  apply: (lines) => lines.filter((l) => !/^\s+\(use "git .*"\)$/.test(l) && !/^\s+\(.*"git .*".*\)$/.test(l)),
};

function isoDay(date: string): string {
  const t = Date.parse(date);
  return Number.isNaN(t) ? date : new Date(t).toISOString().slice(0, 10);
}

export const gitLog: Rule = {
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
