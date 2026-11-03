import type { Platform } from './index.ts';
import { resolveExecutable, shimScript, withShimPathBlock, wrapperScript } from './posix.ts';

/**
 * Platforms without a service and rc implementation (Windows and other non-macOS, non-Linux systems). Install
 * and dashboard fail with a clear message; executable lookup works everywhere, since the launchers use it on
 * every platform.
 */
export function unsupported(platform: NodeJS.Platform): Platform {
  const install = (): never => {
    throw new Error(`toonarrow install is not supported on ${platform} yet`);
  };
  const posix = platform !== 'win32';
  return {
    installService: install,
    removeService: install,
    wrapperPath: install,
    wrapperScript: posix ? wrapperScript : install,
    shellRc: install,
    withShimPathBlock: posix ? withShimPathBlock : install,
    shimScript: posix ? shimScript : install,
    openUrl: (): never => {
      throw new Error(`toonarrow dashboard is not supported on ${platform} yet`);
    },
    resolveExecutable,
  };
}
