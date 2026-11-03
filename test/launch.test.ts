import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { codexApiKeyAuth, codexProviderOverrides, codexResumeProvider, opencodeConfig, opencodeOpenaiAuth, preToolUseHook, resolveClientBin, shimScript, splitLauncherFlags, withShimPathBlock } from '../src/launch.ts';

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

test('a shim installed under another TOONARROW_HOME is skipped, so it never starts itself again', () => {
  const root = mkdtempSync(join(tmpdir(), 'toonarrow-shim-'));
  const other = join(root, 'other-home-bin');
  const real = join(root, 'real');
  mkdirSync(other);
  mkdirSync(real);
  writeFileSync(join(other, 'kora'), shimScript('kora'));
  writeFileSync(join(real, 'kora'), '#!/bin/sh\necho real\n');
  for (const dir of [other, real]) chmodSync(join(dir, 'kora'), 0o755);
  assert.equal(resolveClientBin('kora', { PATH: [other, real].join(':') }, join(root, 'this-home-bin')), join(real, 'kora'));
  assert.throws(() => resolveClientBin('kora', { PATH: other }, join(root, 'this-home-bin')), /not found in PATH/);
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

test('codex resume: the provider recorded in the rollout is read from session_meta', () => {
  const home = mkdtempSync(join(tmpdir(), 'toonarrow-codex-'));
  const day = join(home, 'sessions', '2026', '11', '03');
  mkdirSync(day, { recursive: true });
  const id = '01a1a0fc-b550-7b92-813a-7760a03fc38c';
  writeFileSync(join(day, `rollout-2026-11-03T11-37-58-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai' } }) + '\n');
  const env = { CODEX_HOME: home };
  assert.equal(codexResumeProvider(['resume', id], env), 'openai');
  assert.equal(codexResumeProvider(['fork', id], env), 'openai');
  assert.equal(codexResumeProvider(['resume'], env), undefined);
  assert.equal(codexResumeProvider(['exec'], env), undefined);
  assert.equal(codexResumeProvider(['resume', 'ffffffff-0000-0000-0000-000000000000'], env), undefined);
});

test('codex resume --last: newest interactive session of the working directory, like Codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'toonarrow-codex-'));
  const day = join(home, 'sessions', '2026', '11', '03');
  mkdirSync(day, { recursive: true });
  const env = { CODEX_HOME: home };
  const session = (n: number, payload: object, mtime: number): void => {
    const f = join(day, `rollout-2026-11-03T12-00-0${n}-ffffffff-0000-0000-0000-00000000000${n}.jsonl`);
    writeFileSync(f, JSON.stringify({ type: 'session_meta', payload }) + '\n');
    utimesSync(f, mtime, mtime);
  };
  session(1, { model_provider: 'toonarrow', cwd: '/repo/a', source: 'cli' }, 1000);
  session(2, { model_provider: 'openai', cwd: '/repo/b', source: 'vscode' }, 2000);
  session(3, { model_provider: 'other', cwd: '/repo/a', source: 'exec' }, 3000);
  assert.equal(codexResumeProvider(['resume', '--last'], env, '/repo/a'), 'toonarrow', 'exec runs are skipped');
  assert.equal(codexResumeProvider(['resume', '--last', '--include-non-interactive'], env, '/repo/a'), 'other');
  assert.equal(codexResumeProvider(['resume', '--last', '--all'], env, '/repo/a'), 'openai', 'newest interactive anywhere');
  assert.equal(codexResumeProvider(['-C', '/repo/b', 'resume', '--last'], env, '/repo/a'), 'openai');
  assert.equal(codexResumeProvider(['resume', '--last'], env, '/repo/none'), undefined);
});

test('codex provider overrides: openai_base_url to the proxy, legacy toonarrow sessions keep their provider', () => {
  const p = (resumed: string | undefined, up: boolean) => codexProviderOverrides(resumed, up, 'http://127.0.0.1:48700').join(' ');
  assert.equal(p(undefined, true), '-c openai_base_url="http://127.0.0.1:48700/chatgpt"');
  assert.equal(p('openai', true), '-c openai_base_url="http://127.0.0.1:48700/chatgpt"');
  assert.equal(p('openai', false), '');
  assert.equal(p(undefined, false), '');
  assert.ok(p('toonarrow', true).includes('model_provider=toonarrow'));
  assert.ok(p('toonarrow', true).includes('base_url="http://127.0.0.1:48700/chatgpt"'));
  assert.ok(p('toonarrow', false).includes('base_url="https://chatgpt.com/backend-api/codex"'));
  assert.equal(codexProviderOverrides('openai', true, 'http://h', true).join(' '), '-c openai_base_url="http://h/openai/v1"', 'API key sign-in');
  assert.equal(codexProviderOverrides(undefined, false, 'http://h', true).join(' '), '');
});

test('codex sign-in type: only auth_mode "apikey" routes to the API base', () => {
  const home = mkdtempSync(join(tmpdir(), 'toonarrow-codex-'));
  const env = { CODEX_HOME: home };
  assert.equal(codexApiKeyAuth(env), false, 'no auth.json (keyring store)');
  for (const [mode, expected] of [['apikey', true], ['chatgpt', false], ['chatgptAuthTokens', false]] as const) {
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: mode, OPENAI_API_KEY: null }));
    assert.equal(codexApiKeyAuth(env), expected, mode);
  }
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
