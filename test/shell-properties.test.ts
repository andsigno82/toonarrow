import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressBashOutput, RULE_NAMES } from '../src/compress/shell/index.ts';
import { SHELL_SAMPLES } from './fixtures/shell-samples.ts';

test('every rule has at least one sample', () => {
  const covered = new Set(SHELL_SAMPLES.map((s) => s.rule));
  for (const name of RULE_NAMES) assert.ok(covered.has(name), `no sample for rule ${name}`);
});

for (const s of SHELL_SAMPLES) {
  test(`${s.name}: applies ${s.rule}, keeps its signals, is deterministic and idempotent`, () => {
    const r = compressBashOutput(s.command, s.output);
    assert.equal(r.rule, s.rule);
    assert.equal(r.applied, true);
    assert.ok(r.text.length < s.output.length, 'never longer');
    assert.match(r.text, /\n\[toonarrow [^\n]*\]$/, 'footer with the escape hatch');
    for (const signal of s.signals) assert.ok(r.text.includes(signal), `signal lost: ${signal}`);
    assert.equal(compressBashOutput(s.command, s.output).text, r.text, 'deterministic');
    const second = compressBashOutput(s.command, r.text);
    assert.equal(second.applied, false);
    assert.equal(second.text, r.text, 'second pass leaves the bytes unchanged');
  });
}
