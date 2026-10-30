import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { opencodeConfig, opencodeOpenaiAuth, preToolUseHook, resolveClientBin, shimScript, splitLauncherFlags, withShimPathBlock } from '../src/launch.ts';

test('shim PATH block in the shell rc is idempotent and removable', () => {
  const rc = 'export FOO=1\nalias ll="ls -l"\n';
  const once = withShimPathBlock(rc, true, '/h/.toonarrow/bin');
  assert.ok(once.startsWith(rc.trimEnd()));
  assert.ok(once.includes('export PATH="/h/.toonarrow/bin:$PATH"'));
  assert.equal(withShimPathBlock(once, true, '/h/.toonarrow/bin'), once, 'installing twice leaves one block');
  assert.equal(withShimPathBlock(once, false, '/h/.toonarrow/bin'), rc.trimEnd(), 'uninstall restores the user text');
  assert.equal(withShimPathBlock('', false), '', 'nothing to remove');
});

test('a shim resolves the real client after its own directory, never itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'toonarrow-shim-'));
  const wrapper = join(root, 'wrapper');
  const shims = join(root, 'shims');
  const real = join(root, 'real');
  for (const [dir, body] of [[wrapper, 'wrapper'], [shims, 'shim'], [real, 'real']] as const) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'kora'), `#!/bin/sh\necho ${body}\n`);
    chmodSync(join(dir, 'kora'), 0o755);
  }
  // A wrapper placed before the shims (cmux) has already run: resolution starts after the shim directory.
  assert.equal(resolveClientBin('kora', { PATH: [wrapper, shims, real].join(':') }, shims), join(real, 'kora'));
  // Shims not in PATH (explicit `toonarrow kora`): first match that is not a shim.
  assert.equal(resolveClientBin('kora', { PATH: [shims, real].join(':') }, join(root, 'elsewhere')), join(shims, 'kora'));
  assert.throws(() => resolveClientBin('kora', { PATH: shims }, shims), /not found in PATH/);
  assert.match(shimScript('kora'), /shim kora "\$@"\n$/);
});

test('launcher flags: brief by default, toonarrow flags never reach the client', () => {
  assert.deepEqual(splitLauncherFlags(['run', '-m', 'x']), { tools: false, brief: true, args: ['run', '-m', 'x'] });
  assert.deepEqual(splitLauncherFlags(['--toonarrow-tools', '--toonarrow-no-brief', 'run']), { tools: true, brief: false, args: ['run'] });
});

test('opencode config: default routes providers, adds the instructions and leaves native tools alone', () => {
  const c = opencodeConfig('http://127.0.0.1:1', '/tmp/i.md', false) as any;
  assert.deepEqual(Object.keys(c), ['instructions', 'provider']);
  assert.deepEqual(c.instructions, ['/tmp/i.md']);
  assert.deepEqual(Object.keys(opencodeConfig('http://h', undefined, false)), ['provider'], 'no instructions with --toonarrow-no-brief');
  assert.equal(c.provider['zai-coding-plan'].options.baseURL, 'http://127.0.0.1:1/zai-coding-plan');
  assert.equal(c.provider['minimax-coding-plan'].options.baseURL, 'http://127.0.0.1:1/minimax');
  assert.deepEqual(opencodeConfig(undefined, undefined, false), {}, 'no routing when the proxy is down');
});

test('opencode: OpenAI routed by sign-in type, auth store read for its type only', () => {
  const oauth = opencodeConfig('http://h', '/i', false, 'oauth') as any;
  assert.equal(oauth.provider.openai.options.baseURL, 'http://h/chatgpt');
  const api = opencodeConfig('http://h', '/i', false, 'api') as any;
  assert.equal(api.provider.openai.options.baseURL, 'http://h/openai/v1');
  assert.equal((opencodeConfig('http://h', '/i', false) as any).provider.openai, undefined);

  const data = mkdtempSync(join(tmpdir(), 'toonarrow-oc-'));
  mkdirSync(join(data, 'opencode'));
  writeFileSync(join(data, 'opencode', 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'secret' } }));
  assert.equal(opencodeOpenaiAuth({ XDG_DATA_HOME: data }), 'oauth');
  assert.equal(opencodeOpenaiAuth({ XDG_DATA_HOME: join(data, 'missing') }), undefined);
});

test('opencode config with --toonarrow-tools: direct MCP tools, native file tools off, instructions added', () => {
  const c = opencodeConfig('http://127.0.0.1:1', '/tmp/i.md', true) as any;
  assert.equal(c.mcp.servers.toonarrow.codemode, false);
  assert.equal(c.tools.read, false);
  assert.equal(c.tools.apply_patch, false);
  assert.equal(c.permission, undefined);
  assert.deepEqual(c.instructions, ['/tmp/i.md']);
});

test('hook is inert unless the session was started by toonarrow', async () => {
  assert.equal(await preToolUseHook(JSON.stringify({ tool_name: 'Read' }), {}), '');
});

test('hook denies native file tools and names the replacement', async () => {
  const env = { TOONARROW_TOOLGATE: '1' };
  const read = JSON.parse(await preToolUseHook(JSON.stringify({ tool_name: 'Grep' }), env));
  assert.equal(read.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(read.hookSpecificOutput.permissionDecisionReason, /mcp__toonarrow__Search/);
  const write = JSON.parse(await preToolUseHook(JSON.stringify({ tool_name: 'Write' }), env));
  assert.match(write.hookSpecificOutput.permissionDecisionReason, /mcp__toonarrow__Edit/);
  assert.equal(await preToolUseHook(JSON.stringify({ tool_name: 'Bash' }), env), '');
  assert.equal(await preToolUseHook('not json', env), '');
});
