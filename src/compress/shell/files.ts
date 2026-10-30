import { type Cmd, type Rule, hasShortFlag, humanSize, plural, truncate } from './common.ts';

const LS_LONG = /^([-dlcbps])[-rwxsStTlL]{9}[@+.]?\s+\d+\s+\S+\s+\S+\s+(\S+)\s+(?:\S+\s+){3}(.*)$/;

export const lsLong: Rule = {
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

function commonDir(paths: string[]): string {
  if (paths.length < 2) return '';
  let prefix = paths[0]!;
  for (const p of paths) while (!p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const slash = prefix.lastIndexOf('/');
  return slash > 0 ? prefix.slice(0, slash + 1) : '';
}

export const grep: Rule = {
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

export const findList: Rule = {
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
