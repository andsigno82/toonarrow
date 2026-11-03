import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Reads the `developer_instructions` a Codex run would use, so the launcher can append toonarrow's guidance to
 * it: a `-c developer_instructions=...` override replaces the configured value, it does not add to it.
 * Only TOML string values are read (basic, literal, multi-line); nothing else in the files is interpreted.
 */

/** Decodes a TOML string value starting at `src[i]`; undefined when it is not a string this reader knows. */
export function tomlString(src: string, i: number): string | undefined {
  const multi = src.startsWith('"""', i) || src.startsWith("'''", i);
  const q = src[i];
  if (q !== '"' && q !== "'") return undefined;
  const literal = q === "'";
  const close = multi ? q.repeat(3) : q;
  let j = i + (multi ? 3 : 1);
  if (multi && src[j] === '\n') j++;
  else if (multi && src.startsWith('\r\n', j)) j += 2;
  let out = '';
  for (; j < src.length; j++) {
    if (src.startsWith(close, j)) {
      // A multi-line string may end with up to two quotes of its own: `"""a""""` is `a"`.
      if (multi) {
        for (let k = 0; k < 2 && src[j + 3] === q; k++) out += src[j++];
      }
      return out;
    }
    const c = src[j]!;
    if (!multi && c === '\n') return undefined;
    if (literal || c !== '\\') {
      out += c;
      continue;
    }
    const e = src[++j];
    if (multi && (e === '\n' || e === ' ' || e === '\t' || e === '\r')) {
      // Line-ending backslash: drop the newline and the whitespace that follows.
      while (j < src.length && /[\s]/.test(src[j]!)) j++;
      j--;
      continue;
    }
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (e !== undefined && e in simple) out += simple[e];
    else if (e === 'u' || e === 'U') {
      const n = e === 'u' ? 4 : 8;
      const hex = src.slice(j + 1, j + 1 + n);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) return undefined;
      out += String.fromCodePoint(parseInt(hex, 16));
      j += n;
    } else return undefined;
  }
  return undefined;
}

const KEY = /^[ \t]*(?:developer_instructions|"developer_instructions"|'developer_instructions')[ \t]*=[ \t]*/;

/**
 * `developer_instructions` of one TOML table (`''` = top level, `profiles.fast` = `[profiles.fast]`):
 * `{ found: false }` when absent, `{ found: true, value }` when read, `{ found: true }` when present in a form
 * this reader does not decode.
 */
export function tomlDeveloperInstructions(src: string, table = ''): { found: boolean; value?: string } {
  let current = '';
  let offset = 0;
  for (const line of src.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const header = /^[ \t]*\[([^\[\]]+)\][ \t]*(?:#.*)?$/.exec(line);
    if (header) {
      current = header[1]!.trim().replace(/[ \t]*\.[ \t]*/g, '.').replace(/^"([^"]*)"$/, '$1');
      continue;
    }
    if (current !== table) continue;
    const m = KEY.exec(line);
    if (!m) continue;
    const value = tomlString(src, start + m[0].length);
    return value === undefined ? { found: true } : { found: true, value };
  }
  return { found: false };
}

/** The profile named on the command line (`-p name`, `--profile name`, `--profile=name`), if any. */
function profileArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--profile') && args[i + 1]) return args[i + 1];
    if (args[i]!.startsWith('--profile=')) return args[i]!.slice('--profile='.length);
  }
  return undefined;
}

/** Nearest `.codex/config.toml` from `cwd` up to the filesystem root, excluding the user's CODEX_HOME. */
function projectConfig(cwd: string, codexHome: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, '.codex', 'config.toml');
    if (resolve(dir, '.codex') !== resolve(codexHome) && existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * The configured `developer_instructions` for this Codex run, highest precedence first: the selected profile,
 * the project config, the user config. `unreadable` names the file when the value is there but not decodable.
 */
export function codexDeveloperInstructions(args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): { value?: string; unreadable?: string } {
  const home = env.CODEX_HOME ?? join(homedir(), '.codex');
  const user = join(home, 'config.toml');
  const project = projectConfig(cwd, home);
  const profile = profileArg(args);
  const layers: Array<[string, string]> = [];
  if (profile) for (const f of [project, user]) if (f) layers.push([f, `profiles.${profile}`]);
  for (const f of [project, user]) if (f) layers.push([f, '']);
  for (const [file, table] of layers) {
    const src = read(file);
    if (src === undefined) continue;
    const r = tomlDeveloperInstructions(src, table);
    if (!r.found) continue;
    return r.value === undefined ? { unreadable: file } : { value: r.value };
  }
  return {};
}
