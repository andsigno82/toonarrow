import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shimScript } from '../src/launch.ts';

/**
 * End to end with real processes: shim -> (cmux-like wrapper) -> client. The wrapper drops its own directory and
 * re-runs `claude` from PATH, which used to land on the shim again and loop forever.
 */
function shimChain(order: 'wrapper-after-shims' | 'wrapper-before-shims', proxyPort: number) {
  const root = mkdtempSync(join(tmpdir(), 'toonarrow-chain-'));
  const home = join(root, 'home');
  const shims = join(home, 'bin');
  const wrapper = join(root, 'wrapper');
  const real = join(root, 'real');
  for (const dir of [shims, wrapper, real]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port: proxyPort }));
  writeFileSync(join(shims, 'claude'), shimScript('claude'));
  writeFileSync(
    join(wrapper, 'claude'),
    `#!/bin/bash\nPATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vx '${wrapper}' | paste -sd: -)\nexport PATH\nexec claude "$@"\n`,
  );
  writeFileSync(join(real, 'claude'), '#!/bin/sh\necho "real $TOONARROW_TOOLGATE $*"\n');
  for (const dir of [shims, wrapper, real]) chmodSync(join(dir, 'claude'), 0o755);
  const dirs = order === 'wrapper-after-shims' ? [shims, wrapper, real] : [wrapper, shims, real];
  // The shim binds HOME_DIR (and so the shim directory) from TOONARROW_HOME in its own process.
  // Own process group, so a runaway chain can be killed as a whole.
  const child = spawn('claude', ['--version'], { detached: true, env: { PATH: [...dirs, '/usr/bin', '/bin'].join(':'), HOME: root, TOONARROW_HOME: home } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c));
  child.stderr.on('data', (c: Buffer) => (stderr += c));
  return new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolveRun) => {
    // A loop never exits: kill the whole chain after a bound instead of hanging the suite.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      resolveRun({ stdout, stderr, timedOut: true });
    }, 15_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, timedOut: false });
    });
  });
}

const closedPort = async (): Promise<number> => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
};

test('shim chain with a cmux-like wrapper never loops, proxy off: plain passthrough', async () => {
  const port = await closedPort();
  for (const order of ['wrapper-after-shims', 'wrapper-before-shims'] as const) {
    const r = await shimChain(order, port);
    assert.equal(r.timedOut, false, `${order}: loop`);
    // No tool gate, no launcher flags: the client runs exactly as without toonarrow.
    assert.match(r.stdout.trim(), /^real +--version$/, `${order}: ${r.stderr}`);
  }
});

test('shim chain with a cmux-like wrapper never loops, proxy on: launcher flags reach the client once', async () => {
  const health = createServer((_, res) => res.end(JSON.stringify({ ok: true, features: ['via'] })));
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', r));
  const port = (health.address() as AddressInfo).port;
  try {
    for (const order of ['wrapper-after-shims', 'wrapper-before-shims'] as const) {
      const r = await shimChain(order, port);
      assert.equal(r.timedOut, false, `${order}: loop`);
      const out = r.stdout.trim();
      assert.match(out, /^real 1 --mcp-config \S+ --settings \S+ --append-system-prompt-file \S+ --version$/, `${order}: ${out} ${r.stderr}`);
    }
  } finally {
    health.close();
  }
});

