import type { Platform } from './index.ts';
import { resolveExecutable, shimScript, withShimPathBlock, wrapperScript } from './posix.ts';

/**
 * Platforms without a service and rc implementation yet. Install and dashboard fail with a clear message.
 * Linux already shares the POSIX wrapper, shims and PATH block with macOS; executable lookup works everywhere,
 * since the launchers use it on every platform.
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
