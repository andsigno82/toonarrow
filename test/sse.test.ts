import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../src/sse.ts';
import type { SseEvent } from '../src/sse.ts';

const parse = (chunks: string[]): SseEvent[] => {
  const events: SseEvent[] = [];
  const p = new SseParser((e) => events.push(e));
  for (const c of chunks) p.push(new TextEncoder().encode(c));
  p.end();
  return events;
};

test('parses events split across arbitrary chunk boundaries', () => {
  const raw = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n';
  const whole = parse([raw]);
  for (let i = 1; i < raw.length; i++) assert.deepEqual(parse([raw.slice(0, i), raw.slice(i)]), whole);
  assert.deepEqual(whole, [
    { event: 'a', data: '{"x":1}' },
    { event: 'b', data: '{"y":2}' },
  ]);
});

test('handles CRLF, comments, multi-line data and default event name', () => {
  assert.deepEqual(parse([': ping\r\ndata: one\r\ndata: two\r\n\r\n']), [{ event: 'message', data: 'one\ntwo' }]);
});

test('flushes a trailing event without blank line on end()', () => {
  assert.deepEqual(parse(['data: [DONE]']), [{ event: 'message', data: '[DONE]' }]);
});

test('decodes multi-byte UTF-8 split between chunks', () => {
  const bytes = new TextEncoder().encode('data: è\n\n');
  const events: SseEvent[] = [];
  const p = new SseParser((e) => events.push(e));
  p.push(bytes.slice(0, 7));
  p.push(bytes.slice(7));
  p.end();
  assert.deepEqual(events, [{ event: 'message', data: 'è' }]);
});
