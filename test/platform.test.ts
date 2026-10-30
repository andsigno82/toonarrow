import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchdPlist, wrapperScript } from '../src/platform/darwin.ts';
import { currentPlatform } from '../src/platform/index.ts';
import { envWithPath } from '../src/launch.ts';

const cmd = { execPath: '/opt/node/bin/node', cliPath: '/opt/toonarrow/src/cli.ts' };

test('linux and win32: service, wrapper, shim and rc methods fail with a clear error', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const p = currentPlatform(platform);
    const message = `toonarrow install is not supported on ${platform} yet`;
    assert.throws(() => p.installService(cmd, '/logs'), { message });
    assert.throws(() => p.removeService(), { message });
    assert.throws(() => p.wrapperPath(), { message });
    assert.throws(() => p.wrapperScript(cmd), { message });
    assert.throws(() => p.shellRc(), { message });
    assert.throws(() => p.withShimPathBlock('', true, '/h/bin'), { message });
    assert.throws(() => p.shimScript('kora', cmd), { message });
  }
});

test('darwin service, wrapper, shim and rc text keep the bytes of the pre-refactor output', () => {
  assert.equal(
    launchdPlist(cmd, '/home/u/.toonarrow/logs'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>dev.toonarrow.proxy</string>',
      '  <key>ProgramArguments</key>',
      '  <array><string>/opt/node/bin/node</string><string>--disable-warning=ExperimentalWarning</string><string>/opt/toonarrow/src/cli.ts</string><string>serve</string></array>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '  <key>StandardOutPath</key><string>/home/u/.toonarrow/logs/toonarrow.out.log</string>',
      '  <key>StandardErrorPath</key><string>/home/u/.toonarrow/logs/toonarrow.err.log</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
  assert.equal(
    wrapperScript(cmd),
    "#!/usr/bin/env bash\nexec '/opt/node/bin/node' --disable-warning=ExperimentalWarning '/opt/toonarrow/src/cli.ts' \"$@\"\n",
  );
  assert.equal(
    currentPlatform('darwin').shimScript('kora', cmd),
    [
      '#!/usr/bin/env bash',
      '# toonarrow shim, written by `toonarrow install`: attaches toonarrow to kora while the proxy runs, otherwise runs kora unchanged.',
      `exec '/opt/node/bin/node' '--disable-warning=ExperimentalWarning' '/opt/toonarrow/src/cli.ts' shim kora "$@"`,
      '',
    ].join('\n'),
  );
  assert.equal(
    currentPlatform('darwin').withShimPathBlock('export FOO=1\n', true, '/h/bin'),
    [
      'export FOO=1',
      '',
      '# >>> toonarrow shims >>>',
      '# toonarrow attaches to claude, codex, opencode and kora when it runs (`toonarrow uninstall` removes this block).',
      'case ":$PATH:" in *":/h/bin:"*) ;; *) export PATH="/h/bin:$PATH" ;; esac',
      '# <<< toonarrow shims <<<',
      '',
    ].join('\n'),
  );
});

test('child env keeps the PATH key casing of the source env', () => {
  assert.deepEqual(envWithPath({ PATH: '/a', HOME: '/h' }, '/b'), { PATH: '/b', HOME: '/h' });
  assert.deepEqual(envWithPath({ Path: 'C:\\a' }, 'C:\\b'), { Path: 'C:\\b' });
  assert.deepEqual(envWithPath({ HOME: '/h' }, '/b'), { HOME: '/h', PATH: '/b' });
});
