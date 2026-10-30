import { darwin } from './darwin.ts';
import { unsupported } from './unsupported.ts';

/** How the wrapper, shims and service run toonarrow: the node binary and the CLI entry point. */
export interface CliCommand {
  execPath: string;
  cliPath: string;
}

/** The background proxy service as installed: its label and definition file. */
export interface ServiceRef {
  label: string;
  path: string;
}

/**
 * What differs between operating systems: the background service, the `toonarrow` wrapper, the shims, the shell rc
 * block, opening a URL and locating an executable. Everything else (PATH handling, launchers, config) is portable.
 */
export interface Platform {
  /** Writes the service definition and starts the proxy as a background service, replacing an installed one. */
  installService(cmd: CliCommand, logDir: string): ServiceRef;
  /** Stops the background service and removes its definition. */
  removeService(): void;
  wrapperPath(): string;
  wrapperScript(cmd: CliCommand): string;
  /** Shell rc file that receives the shim PATH block. */
  shellRc(): string;
  /** Rc text with the shim PATH block added or removed. Pure and idempotent. */
  withShimPathBlock(text: string, add: boolean, shimDir: string): string;
  shimScript(client: string, cmd: CliCommand): string;
  openUrl(url: string): void;
  /** First `name` in `dirs` that can be executed, in order. */
  resolveExecutable(name: string, dirs: string[]): string | undefined;
}

export function currentPlatform(platform: NodeJS.Platform = process.platform): Platform {
  return platform === 'darwin' ? darwin : unsupported(platform);
}
