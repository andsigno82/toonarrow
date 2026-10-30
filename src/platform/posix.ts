import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CliCommand } from './index.ts';

/** POSIX pieces shared by macOS and Linux: bash wrapper and shims, the PATH block for sh-compatible rc files. */

export const NODE_FLAG = '--disable-warning=ExperimentalWarning';
const RC_BEGIN = '# >>> toonarrow shims >>>';
const RC_END = '# <<< toonarrow shims <<<';

export function wrapperScript({ execPath, cliPath }: CliCommand): string {
  return `#!/usr/bin/env bash\nexec '${execPath}' ${NODE_FLAG} '${cliPath}' "$@"\n`;
}

export function shimScript(client: string, { execPath, cliPath }: CliCommand): string {
  return `#!/usr/bin/env bash\n# toonarrow shim, written by \`toonarrow install\`: attaches toonarrow to ${client} while the proxy runs, otherwise runs ${client} unchanged.\nexec '${execPath}' '${NODE_FLAG}' '${cliPath}' shim ${client} "$@"\n`;
}

/**
 * Shell rc text with the toonarrow PATH block replaced (`add`) or removed. Pure and idempotent: installing twice
 * leaves one block, and text outside the markers is never touched.
 */
export function withShimPathBlock(text: string, add: boolean, shimDir: string): string {
  let out = text;
  const start = out.indexOf(RC_BEGIN);
  const end = out.indexOf(RC_END);
  if (start >= 0 && end > start) {
    const before = out.slice(0, start).replace(/\n+$/, '');
    const after = out.slice(end + RC_END.length).replace(/^\n+/, '');
    out = before + (before && after ? '\n\n' : '') + after;
  }
  if (!add) return out;
  const block = [
    RC_BEGIN,
    '# toonarrow attaches to claude, codex, opencode and kora when it runs (`toonarrow uninstall` removes this block).',
    `case ":$PATH:" in *":${shimDir}:"*) ;; *) export PATH="${shimDir}:$PATH" ;; esac`,
    RC_END,
  ].join('\n');
  return `${out.replace(/\n*$/, '')}${out.trim() ? '\n\n' : ''}${block}\n`;
}

/** First `name` in `dirs` that is an executable file. X_OK is the POSIX check; Windows also needs PATHEXT. */
export function resolveExecutable(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // not here
    }
  }
  return undefined;
}
