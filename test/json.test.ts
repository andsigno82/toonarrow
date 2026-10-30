import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTopLevelStrings, minifyJson, topLevelStringSpans } from '../src/compress/json.ts';

test('topLevelStringSpans finds raw string values and rejects non-objects', () => {
  const text = '{ "a": "x\\"y", "n": 12, "o": {"a": "nested"}, "s": "\\u003cb\\u003e" }';
  const spans = topLevelStringSpans(text)!;
  assert.deepEqual([...spans.keys()], ['a', 's']);
  assert.equal(text.slice(...spans.get('s')!), '"\\u003cb\\u003e"');
  for (const bad of ['[1]', '"s"', '{"a": "x"', '{"a": "x"} trailing', '']) assert.equal(topLevelStringSpans(bad), undefined, bad);
  assert.deepEqual(topLevelStringSpans(' {} '), new Map());
});

test('editTopLevelStrings changes only the edited field bytes', () => {
  // Go's encoding/json escapes <, > and &: those bytes must survive untouched.
  const text = '{"success":false,"stdout":"line\\nline","stderr":"\\u003cerr\\u003e","exit_code":1}';
  const out = editTopLevelStrings(text, ['stdout', 'stderr'], (key, v) => (key === 'stdout' ? v.toUpperCase() : v));
  assert.equal(out, '{"success":false,"stdout":"LINE\\nLINE","stderr":"\\u003cerr\\u003e","exit_code":1}');
  assert.equal(editTopLevelStrings(text, ['stdout'], (_k, v) => v), text);
  assert.equal(editTopLevelStrings('not json', ['stdout'], () => 'x'), 'not json');
});

test('minifyJson drops whitespace outside strings only, and is idempotent', () => {
  const text = '{\n  "a": "keep  this\\n spacing",\n  "b": [1, 2,\t3],\n  "c": {"d": "\\u003c"}\n}';
  const once = minifyJson(text)!;
  assert.equal(once, '{"a":"keep  this\\n spacing","b":[1,2,3],"c":{"d":"\\u003c"}}');
  assert.equal(minifyJson(once), once);
  assert.deepEqual(JSON.parse(once), JSON.parse(text));
  assert.equal(minifyJson('{"a": }'), undefined);
});
