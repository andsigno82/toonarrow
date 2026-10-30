import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressBashOutput } from '../src/compress/bash.ts';
import { rewriteAnthropic, rewriteChat, rewriteResponses } from '../src/compress/request.ts';

export const LS_OUTPUT = ['total 2048', ...Array.from({ length: 30 }, (_, i) => `-rw-r--r--@  1 andrea  staff  ${1000 + i} 24 set 09:10 file-${i}.ts`)].join('\n');

const conversation = () => ({
  model: 'claude-x',
  messages: [
    { role: 'user', content: 'list files' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la | cat' } },
        { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: LS_OUTPUT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: LS_OUTPUT }] },
        { type: 'tool_result', tool_use_id: 't3', content: LS_OUTPUT },
      ],
    },
  ],
});

test('compresses Bash results only, keeps other fields and non-Bash tools untouched', () => {
  const body = conversation();
  const stats = rewriteAnthropic(body);
  const results = (body.messages[2]!.content as any[]);
  assert.equal(stats.bashBlocks, 1);
  assert.ok(stats.bashCharsSaved > 0);
  assert.ok(results[0].content.includes('[toonarrow ls-long:'));
  assert.deepEqual(results[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(results[1].content[0].text, LS_OUTPUT, 'compound command passes through');
  assert.equal(results[2].content, LS_OUTPUT, 'Read result untouched');
});

test('rewriting is idempotent across requests of the same session', () => {
  const a = conversation();
  const b = conversation();
  rewriteAnthropic(a);
  rewriteAnthropic(b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // A second pass over already-compressed history must not change it again.
  const again = structuredClone(a);
  assert.equal(rewriteAnthropic(again).bashBlocks, 0);
  assert.equal(JSON.stringify(again), JSON.stringify(a));
});

const codexInput = () => ({
  model: 'gpt-x',
  store: false,
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
    { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"ls -la .",max_output_tokens:6000}));\n' },
    {
      type: 'custom_tool_call_output',
      call_id: 'c1',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.5 seconds\nOutput:\n' },
        { type: 'input_text', text: JSON.stringify({ chunk_id: 'a', wall_time_seconds: 0.00000225, exit_code: 0, original_token_count: 1004, output: LS_OUTPUT }) },
      ],
    },
    { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls -la' }) },
    { type: 'function_call_output', call_id: 'c2', output: `Exit code: 0\nOutput:\n${LS_OUTPUT}` },
    { type: 'function_call', call_id: 'c3', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la | cat'] }) },
    { type: 'function_call_output', call_id: 'c3', output: JSON.stringify({ output: LS_OUTPUT, metadata: { exit_code: 0 } }) },
    { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'const a = await tools.exec_command({cmd:"ls -la"}); text(a);' },
    { type: 'custom_tool_call_output', call_id: 'c4', output: [{ type: 'input_text', text: LS_OUTPUT }] },
  ],
});

test('codex: compresses code-mode exec and exec_command outputs, skips compound and multi-statement scripts', () => {
  const body = codexInput();
  const stats = rewriteResponses(body);
  assert.equal(stats.bashBlocks, 2);
  const out = body.input as any[];
  const inner = JSON.parse(out[2].output[1].text);
  assert.ok(inner.output.includes('[toonarrow ls-long:'));
  assert.equal(inner.exit_code, 0);
  assert.equal(out[2].output[0].text, 'Script completed\nWall time 0.5 seconds\nOutput:\n');
  assert.ok(out[4].output.startsWith('Exit code: 0\nOutput:\n'));
  assert.ok(out[4].output.includes('[toonarrow ls-long:'));
  assert.equal(JSON.parse(out[6].output).output, LS_OUTPUT, 'compound bash -lc passes through');
  assert.equal(out[8].output[0].text, LS_OUTPUT, 'multi-statement script passes through');
});

test('codex: rewriting is deterministic and idempotent', () => {
  const a = codexInput();
  const b = codexInput();
  rewriteResponses(a);
  rewriteResponses(b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const again = structuredClone(a);
  assert.equal(rewriteResponses(again).bashBlocks, 0);
  assert.equal(JSON.stringify(again), JSON.stringify(a));
});

// Shape observed from Codex 0.160.1 (gpt-6.1-sol): several text(await tools.exec_command(...)) statements in one
// script, answered by a header part and one JSON result per call, in order.
const multiCall = (results: string[]) => ({
  input: [
    {
      type: 'custom_tool_call',
      call_id: 'm1',
      name: 'exec',
      input: 'text(await tools.exec_command({cmd:"ls -la src","max_output_tokens":4000}));\ntext(await tools.exec_command({cmd:"ls -la test","max_output_tokens":1000}));\n',
    },
    {
      type: 'custom_tool_call_output',
      call_id: 'm1',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 0.3 seconds\nOutput:\n' }, ...results.map((text) => ({ type: 'input_text', text }))],
    },
  ],
});
const execResult = (output: string) => JSON.stringify({ chunk_id: 'c', wall_time_seconds: 0.000002, exit_code: 0, output });

test('codex: a script of several plain exec_command calls gets each result compressed with its own command', () => {
  const body = multiCall([execResult(LS_OUTPUT), execResult(LS_OUTPUT)]);
  assert.equal(rewriteResponses(body).bashBlocks, 2);
  const parts = (body.input[1] as any).output;
  assert.equal(parts[0].text, 'Script completed\nWall time 0.3 seconds\nOutput:\n', 'header untouched');
  for (const p of parts.slice(1)) assert.ok(JSON.parse(p.text).output.includes('[toonarrow ls-long:'));
  const again = structuredClone(body);
  assert.equal(rewriteResponses(again).bashBlocks, 0, 'idempotent');
  assert.equal(JSON.stringify(again), JSON.stringify(body));
});

test('codex: results that do not line up one per call, or scripts with other statements, pass through', () => {
  const short = multiCall([execResult(LS_OUTPUT)]);
  assert.equal(rewriteResponses(short).bashBlocks, 0);
  const derived = {
    input: [
      { type: 'custom_tool_call', call_id: 'd1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"ls -la"}); text(r.output);\ntext({n: 1});' },
      { type: 'custom_tool_call_output', call_id: 'd1', output: [{ type: 'input_text', text: LS_OUTPUT }] },
    ],
  };
  assert.equal(rewriteResponses(derived).bashBlocks, 0);
});

test('kora cli: executeCommand JSON results get stdout compressed, other fields kept', () => {
  const result = JSON.stringify({ exit_code: 0, stderr: '', stdout: LS_OUTPUT, success: true });
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'executeCommand', arguments: JSON.stringify({ command: 'ls -la', readOnly: true }) } }] },
      { role: 'tool', tool_call_id: 'k1', content: result },
    ],
  };
  const stats = rewriteChat(body);
  assert.equal(stats.bashBlocks, 1);
  const out = JSON.parse(body.messages[1]!.content as string);
  assert.ok(out.stdout.includes('[toonarrow ls-long:'));
  assert.deepEqual({ ...out, stdout: '' }, { exit_code: 0, stderr: '', stdout: '', success: true });

  const again = structuredClone(body);
  assert.equal(rewriteChat(again).bashBlocks, 0);
  assert.equal(JSON.stringify(again), JSON.stringify(body));

  const responses = {
    input: [
      { type: 'function_call', call_id: 'r1', name: 'executeCommand', arguments: JSON.stringify({ command: 'ls -la' }) },
      { type: 'function_call_output', call_id: 'r1', output: result },
    ],
  };
  assert.equal(rewriteResponses(responses).bashBlocks, 1);
});

test('plain chat tool results are compressed whole, even when they contain "Output:"', () => {
  const text = `Output:\n${LS_OUTPUT}`;
  const body = {
    messages: [
      { role: 'assistant', tool_calls: [{ id: 's1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'ls -la' }) } }] },
      { role: 'tool', tool_call_id: 's1', content: text },
    ],
  };
  rewriteChat(body);
  const whole = compressBashOutput('ls -la', text);
  assert.equal(body.messages[1]!.content, whole.applied ? whole.text : text);
});

test('ignores bodies without messages', () => {
  assert.deepEqual(rewriteAnthropic({}), { bashBlocks: 0, bashCharsSaved: 0 });
});
