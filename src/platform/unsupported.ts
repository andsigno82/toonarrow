import { resolveExecutable } from './darwin.ts';
import type { Platform } from './index.ts';

/**
 * Platforms without a service, shim and rc implementation yet. Install and dashboard fail with a clear message;
 * executable lookup keeps working, since the launchers use it on every platform.
 */
export function unsupported(platform: NodeJS.Platform): Platform {
  const install = (): never => {
    throw new Error(`toonarrow install is not supported on ${platform} yet`);
  };
  return {
    installService: install,
    removeService: install,
    wrapperPath: install,
    wrapperScript: install,
    shellRc: install,
    withShimPathBlock: install,
    shimScript: install,
    openUrl: (): never => {
      throw new Error(`toonarrow dashboard is not supported on ${platform} yet`);
    },
    resolveExecutable,
  };
}
