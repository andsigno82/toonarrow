import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newResponsesState, rewriteAnthropic, rewriteChat, rewriteResponses } from '../src/compress/request.ts';
import { compressKoraSearch, compressOpencodeGrep } from '../src/compress/search.ts';

const root = '/Users/u/dev/project/';
const grepOutput = [
  'Found 30 matches',
  ...['src/a.ts', 'src/lib/b.ts', 'docs/c.md'].flatMap((f, k) => [`${root}${f}:`, ...Array.from({ length: 10 }, (_, i) => `  Line ${i + 1}: const value${k} = useThing(${i});`), '']),
  '(Results are truncated. Consider using a more specific path or pattern.)',
].join('\n');

test('OpenCode grep: common directory factored, Line N becomes N, every match kept', () => {
  const out = compressOpencodeGrep(grepOutput);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Found 30 matches');
  assert.equal(lines[1], `# paths below are relative to ${root}`);
  assert.equal(lines[2], 'src/a.ts:');
  assert.equal(lines[3], '  1: const value0 = useThing(0);');
  assert.equal(lines.filter((l) => /^ {2}\d+: /.test(l)).length, 30);
  assert.ok(out.endsWith('(Results are truncated. Consider using a more specific path or pattern.)'));
  assert.ok(out.length < grepOutput.length * 0.9);
  assert.equal(compressOpencodeGrep(out), out, 'second pass leaves the bytes unchanged');
  assert.equal(compressOpencodeGrep(grepOutput.replace('  Line 3:', 'unexpected line\n  Line 3:')), grepOutput.replace('  Line 3:', 'unexpected line\n  Line 3:'), 'unknown lines: untouched');
});

const koraResult = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    success: true,
    results: Array.from({ length: 12 }, (_, i) => ({ file: `${root}src/${i < 6 ? 'a' : 'b'}.ts`, line: i + 1, text: `  call("x\\u003c${i}") // "quoted" & <tag>` })),
    count: 12,
    truncated: true,
    note: 'Showing the first 12 matches',
    ...extra,
  });

test('Kora searchCode: JSON becomes grep-style text with count, truncation and note', () => {
  const text = koraResult();
  const out = compressKoraSearch(text);
  const lines = out.split('\n');
  assert.equal(lines[0], 'searchCode: 12 results (truncated)');
  assert.equal(lines[1], 'note: Showing the first 12 matches');
  assert.equal(lines[2], `# paths below are relative to ${root}src/`);
  assert.equal(lines[3], 'a.ts:');
  assert.equal(lines[4], '  1:   call("x\\u003c0") // "quoted" & <tag>');
  assert.equal(lines.filter((l) => /^ {2}\d+: /.test(l)).length, 12);
  assert.ok(out.length < text.length * 0.7);
  assert.equal(compressKoraSearch(out), out);
  for (const bad of [koraResult({ success: false }), koraResult({ extra: 1 }), JSON.stringify({ success: true, results: [{ file: 'a', line: 1, text: 'x\ny' }], count: 1 }).padEnd(600)]) {
    assert.equal(compressKoraSearch(bad), bad);
  }
});

test('router: chat tool results of searchCode and Anthropic grep results are rewritten; errors are not', () => {
  const chat = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'searchCode', arguments: '{"pattern":"call"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: koraResult() },
    ],
  };
  const s = rewriteChat(chat);
  assert.equal(s.toolBlocks, 1);
  assert.ok(s.toolCharsSaved! > 0);
  assert.ok((chat.messages[1] as { content: string }).content.startsWith('searchCode: 12 results'));

  const anthropic = (isError: boolean) => ({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'useThing' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: grepOutput, ...(isError ? { is_error: true } : {}) }] },
    ],
  });
  const ok = anthropic(false);
  assert.equal(rewriteAnthropic(ok).toolBlocks, 1);
  const failed = anthropic(true);
  assert.equal(rewriteAnthropic(failed).toolBlocks, 0);
  assert.equal((failed.messages[1]!.content[0] as { content: string }).content, grepOutput);
});

test('router: Responses search results (Kora and OpenCode with an OpenAI sign-in) are rewritten, also across WebSocket turns', () => {
  const body = () => ({
    input: [
      { type: 'function_call', call_id: 'k1', name: 'searchCode', arguments: '{"pattern":"call"}' },
      { type: 'function_call_output', call_id: 'k1', output: koraResult() },
      { type: 'function_call', call_id: 'g1', name: 'grep', arguments: '{"pattern":"useThing"}' },
      { type: 'function_call_output', call_id: 'g1', output: [{ type: 'input_text', text: grepOutput }] },
      { type: 'function_call', call_id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'r1', output: grepOutput },
    ],
  });
  const once = body();
  const s = rewriteResponses(once);
  assert.equal(s.toolBlocks, 2);
  assert.ok((once.input[1] as { output: string }).output.startsWith('searchCode: 12 results'));
  assert.equal((once.input[3] as { output: { text: string }[] }).output[0]!.text, compressOpencodeGrep(grepOutput));
  assert.equal((once.input[5] as { output: string }).output, grepOutput, 'other tools are left alone');
  const twice = structuredClone(once);
  assert.equal(rewriteResponses(twice).toolBlocks, 0);
  assert.deepEqual(twice, once, 'second pass is a no-op');

  // WebSocket: the call came from the server in an earlier turn, this turn carries only its output.
  const calls = newResponsesState();
  calls.calls.set('k1', { search: 'searchCode' });
  const turn = { input: [{ type: 'function_call_output', call_id: 'k1', output: koraResult() }] };
  assert.equal(rewriteResponses(turn, undefined, calls).toolBlocks, 1);
  assert.equal(turn.input[0]!.output, (once.input[1] as { output: string }).output);
});
