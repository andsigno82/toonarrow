import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path/posix';
import type { CliCommand, Platform } from './index.ts';
import { NODE_FLAG, resolveExecutable, shimScript, withShimPathBlock, wrapperScript } from './posix.ts';

const UNIT = 'toonarrow.service';
const configHome = (): string => process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const unitPath = (): string => join(configHome(), 'systemd', 'user', UNIT);
const WRAPPER_PATH = join(homedir(), '.local', 'bin', 'toonarrow');

/** One argument of a systemd ExecStart line: double-quoted, `\` and `"` escaped, `%` doubled (specifiers). */
const unitArg = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const unitPathValue = (s: string): string => s.replace(/%/g, '%%');

export function systemdUnit({ execPath, cliPath }: CliCommand, logDir: string): string {
  return `[Unit]
Description=toonarrow local context-compression proxy
After=network.target

[Service]
ExecStart=${[execPath, NODE_FLAG, cliPath, 'serve'].map(unitArg).join(' ')}
Restart=always
RestartSec=2
StandardOutput=append:${unitPathValue(join(logDir, 'toonarrow.out.log'))}
StandardError=append:${unitPathValue(join(logDir, 'toonarrow.err.log'))}

[Install]
WantedBy=default.target
`;
}

const systemctl = (...args: string[]): void => {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
};

const NO_USER_SYSTEMD =
  'toonarrow install needs a systemd user session (`systemctl --user`), which is not available here (containers, WSL without systemd). Run `toonarrow serve` in the background instead, e.g. from your shell profile.';

/** The rc file of the login shell: zsh, bash, otherwise ~/.profile. */
export function linuxShellRc(shell = process.env.SHELL ?? '', home = homedir(), zdotdir = process.env.ZDOTDIR): string {
  const name = basename(shell);
  if (name === 'zsh') return join(zdotdir ?? home, '.zshrc');
  if (name === 'bash') return join(home, '.bashrc');
  return join(home, '.profile');
}

/** Linux: a systemd user service, the login shell's rc file and `xdg-open` for the dashboard. */
export const linux: Platform = {
  installService(cmd, logDir) {
    try {
      execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    } catch {
      throw new Error(NO_USER_SYSTEMD);
    }
    mkdirSync(dirname(unitPath()), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    writeFileSync(unitPath(), systemdUnit(cmd, logDir));
    systemctl('daemon-reload');
    systemctl('enable', UNIT);
    systemctl('restart', UNIT);
    return { label: UNIT, path: unitPath() };
  },
  removeService() {
    try {
      systemctl('disable', '--now', UNIT);
    } catch {
      // not installed, or no user session: removing the file is enough
    }
    rmSync(unitPath(), { force: true });
    try {
      systemctl('daemon-reload');
    } catch {
      // no user session
    }
  },
  wrapperPath: () => WRAPPER_PATH,
  wrapperScript,
  shellRc: () => linuxShellRc(),
  withShimPathBlock,
  shimScript,
  openUrl(url) {
    try {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
      // no desktop: the URL is printed by the caller
    }
  },
  resolveExecutable,
};
