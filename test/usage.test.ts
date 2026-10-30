import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/usage.ts';
import type { Wire } from '../src/wire.ts';
import { detectWire } from '../src/wire.ts';

const sse = (events: [string, unknown][]): string => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

function collect(wire: Wire, contentType: string, body: string) {
  const c = createCollector(wire, contentType);
  assert.ok(c);
  const bytes = new TextEncoder().encode(body);
  for (let i = 0; i < bytes.length; i += 7) c.push(bytes.slice(i, i + 7));
  return c.finish();
}

test('detectWire', () => {
  assert.equal(detectWire('/v1/messages'), 'anthropic-messages');
  assert.equal(detectWire('/v1/messages/count_tokens'), 'other');
  assert.equal(detectWire('/backend-api/codex/responses'), 'openai-responses');
  assert.equal(detectWire('/v1/chat/completions/'), 'openai-chat');
});

test('anthropic stream merges message_start and cumulative message_delta usage', () => {
  const body = sse([
    ['message_start', { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 1 } } }],
    ['content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }],
    ['message_delta', { type: 'message_delta', usage: { output_tokens: 42 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  assert.deepEqual(collect('anthropic-messages', 'text/event-stream; charset=utf-8', body), {
    model: 'claude-x',
    usage: { input: 3, cacheRead: 5000, cacheWrite: 100, output: 42, reasoning: 0 },
  });
});

test('openai responses stream reads response.completed, cached tokens excluded from input', () => {
  const body = sse([
    ['response.created', { type: 'response.created', response: { model: 'gpt-x' } }],
    ['response.completed', { type: 'response.completed', response: { model: 'gpt-x', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } } } }],
  ]);
  assert.deepEqual(collect('openai-responses', 'text/event-stream', body), {
    model: 'gpt-x',
    usage: { input: 200, cacheRead: 800, cacheWrite: 0, output: 50, reasoning: 20 },
  });
});

test('openai chat stream picks the usage chunk and ignores [DONE]', () => {
  const body =
    `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: 'a' } }] })}\n\n` +
    `data: ${JSON.stringify({ model: 'm', choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } })}\n\n` +
    'data: [DONE]\n\n';
  assert.deepEqual(collect('openai-chat', 'text/event-stream', body), {
    model: 'm',
    usage: { input: 4, cacheRead: 6, cacheWrite: 0, output: 4, reasoning: 0 },
  });
});

test('error events inside a 2xx stream are reported, first one wins', () => {
  // kora-server relays a gateway 429 as a Chat chunk with an error object and HTTP 200.
  const kora = 'data: {"choices":[{"delta":{"content":"x"}}],"model":"m","usage":null}\n\n'
    + 'data: {"error":{"message":"Gateway error 429: Token Plan usage limit reached","type":"proxy_error"}}\n\n'
    + 'data: {"error":"second"}\n\n';
  assert.equal(collect('openai-chat', 'text/event-stream', kora).streamError, 'Gateway error 429: Token Plan usage limit reached');
  const anthropic = sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]);
  assert.equal(collect('anthropic-messages', 'text/event-stream', anthropic).streamError, 'Overloaded');
  const failed = sse([['response.failed', { type: 'response.failed', response: { model: 'g', error: { code: 'server_error', message: 'boom' } } }]]);
  assert.equal(collect('openai-responses', 'text/event-stream', failed).streamError, 'boom');
  const responsesError = sse([['error', { type: 'error', code: 'rate_limit', message: 'slow down' }]]);
  assert.equal(collect('openai-responses', 'text/event-stream', responsesError).streamError, 'slow down');
  const clean = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n';
  assert.equal(collect('openai-chat', 'text/event-stream', clean).streamError, undefined);
});

test('non-streaming JSON bodies', () => {
  const body = JSON.stringify({ model: 'claude-x', usage: { input_tokens: 9, output_tokens: 2 } });
  assert.deepEqual(collect('anthropic-messages', 'application/json', body), {
    model: 'claude-x',
    usage: { input: 9, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 },
  });
});

test('no collector for unknown wire or content type', () => {
  assert.equal(createCollector('other', 'application/json'), null);
  assert.equal(createCollector('anthropic-messages', 'text/plain'), null);
  assert.equal(createCollector('openai-responses', undefined), null);
});

test('missing content-type falls back to the request stream flag (ChatGPT Codex backend)', () => {
  const c = createCollector('openai-responses', undefined, true);
  assert.ok(c);
  c.push(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"model":"g","usage":{"input_tokens":5,"output_tokens":1}}}\n\n'));
  assert.deepEqual(c.finish().usage, { input: 5, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 });
});
