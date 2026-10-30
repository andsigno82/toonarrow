import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliCommand, Platform } from './index.ts';

const LAUNCHD_LABEL = 'dev.toonarrow.proxy';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const WRAPPER_PATH = join(homedir(), '.local', 'bin', 'toonarrow');
const NODE_FLAG = '--disable-warning=ExperimentalWarning';
const RC_BEGIN = '# >>> toonarrow shims >>>';
const RC_END = '# <<< toonarrow shims <<<';

export function launchdPlist({ execPath, cliPath }: CliCommand, logDir: string): string {
  const args = [execPath, NODE_FLAG, cliPath, 'serve'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, 'toonarrow.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'toonarrow.err.log')}</string>
</dict>
</plist>
`;
}

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

const launchctl = (...args: string[]): void => {
  execFileSync('launchctl', args, { stdio: 'inherit' });
};
const domain = (): string => `gui/${process.getuid?.()}`;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const daemonLoaded = (): boolean => {
  try {
    execFileSync('launchctl', ['print', `${domain()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** bootout returns before launchd has unloaded the job; a bootstrap in that window fails with "Input/output error". */
function unloadDaemon(): void {
  if (!daemonLoaded()) return;
  launchctl('bootout', `${domain()}/${LAUNCHD_LABEL}`);
  for (let i = 0; i < 100 && daemonLoaded(); i++) sleepSync(100);
}

/** macOS: a launchd agent, the zsh rc file and `open` for the dashboard. */
export const darwin: Platform = {
  installService(cmd, logDir) {
    mkdirSync(dirname(PLIST_PATH), { recursive: true });
    unloadDaemon();
    writeFileSync(PLIST_PATH, launchdPlist(cmd, logDir));
    launchctl('bootstrap', domain(), PLIST_PATH);
    return { label: LAUNCHD_LABEL, path: PLIST_PATH };
  },
  removeService() {
    unloadDaemon();
    rmSync(PLIST_PATH, { force: true });
  },
  wrapperPath: () => WRAPPER_PATH,
  wrapperScript,
  shellRc: () => join(process.env.ZDOTDIR ?? homedir(), '.zshrc'),
  withShimPathBlock,
  shimScript,
  openUrl(url) {
    execFileSync('open', [url]);
  },
  resolveExecutable,
};
