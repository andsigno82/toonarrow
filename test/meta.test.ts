import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseRequestJson, redactHeaders, requestMeta } from '../src/meta.ts';

test('claude code session from header wins', () => {
  const m = requestMeta('anthropic-messages', { 'x-claude-code-session-id': 'abc', 'user-agent': 'claude-cli/2.1.312 (external, sdk-cli)' }, { model: 'claude-x', stream: true });
  assert.deepEqual(m, { model: 'claude-x', stream: true, sessionKey: 'abc', sessionSource: 'header:x-claude-code-session-id', client: 'claude-cli/2.1.312' });
});

test('claude code session from JSON metadata.user_id (2.1.x format)', () => {
  const sid = '587b5a99-dd53-4ac4-8af8-8a015a5eac73';
  const m = requestMeta('anthropic-messages', {}, { metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sid }) } });
  assert.equal(m.sessionKey, sid);
  assert.equal(m.sessionSource, 'body:metadata.user_id');
});

test('claude code session from legacy metadata.user_id string', () => {
  const sid = '587b5a99-dd53-4ac4-8af8-8a015a5eac73';
  const m = requestMeta('anthropic-messages', {}, { metadata: { user_id: `user_x_account_y_session_${sid}` } });
  assert.equal(m.sessionKey, sid);
});

test('openai prompt_cache_key fallback', () => {
  assert.equal(requestMeta('openai-responses', {}, { prompt_cache_key: 'k1' }).sessionKey, 'k1');
});

test('kora cli session from the session_id body field', () => {
  const m = requestMeta('openai-chat', {}, { model: 'flash', session_id: 'session-1' });
  assert.equal(m.sessionKey, 'session-1');
  assert.equal(m.sessionSource, 'body:session_id');
  // Kora also sends x-opencode-session-id when a session-header rule is configured: its own id wins.
  const both = requestMeta('openai-chat', { 'x-opencode-session-id': 'uuid-rule' }, { session_id: 'session-1' });
  assert.equal(both.sessionKey, 'session-1');
  assert.equal(requestMeta('openai-chat', { 'x-opencode-session-id': 'uuid-rule' }, {}).sessionKey, 'uuid-rule');
});

test('parses gzip-encoded request bodies and tolerates garbage', () => {
  const body = gzipSync(Buffer.from(JSON.stringify({ model: 'm' })));
  assert.deepEqual(parseRequestJson(body, { 'content-encoding': 'gzip' }), { model: 'm' });
  assert.equal(parseRequestJson(Buffer.from('not json'), {}), undefined);
});

test('redacts credential-bearing headers', () => {
  const r = redactHeaders({ authorization: 'Bearer x', 'x-api-key': 'k', 'chatgpt-account-id': 'a', 'anthropic-version': '2023-06-01' });
  assert.deepEqual(r, { authorization: '<redacted>', 'x-api-key': '<redacted>', 'chatgpt-account-id': '<redacted>', 'anthropic-version': '2023-06-01' });
});
