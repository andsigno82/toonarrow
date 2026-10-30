import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
// macOS paths are POSIX paths, also when this module is exercised by tests on Windows.
import { dirname, join } from 'node:path/posix';
import type { CliCommand, Platform } from './index.ts';
import { NODE_FLAG, resolveExecutable, shimScript, withShimPathBlock, wrapperScript } from './posix.ts';

const LAUNCHD_LABEL = 'dev.toonarrow.proxy';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const WRAPPER_PATH = join(homedir(), '.local', 'bin', 'toonarrow');

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
