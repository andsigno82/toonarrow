import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import type { LedgerEntry } from '../src/ledger.ts';
import { createProxyServer, resolveTarget } from '../src/proxy.ts';

const ANTHROPIC_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":3,"cache_creation_input_tokens":10,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ciao è"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server;
let proxy: http.Server;
let proxyUrl: string;
let ledgerDir: string;
let captureDir: string;
let lastSeen: Seen;

const listen = (s: http.Server): Promise<number> =>
  new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastSeen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      if (req.url?.startsWith('/base/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Dribble the stream byte-group by byte-group to exercise chunk boundaries.
        const bytes = Buffer.from(ANTHROPIC_SSE);
        let i = 0;
        const tick = (): void => {
          if (i >= bytes.length) return void res.end();
          res.write(bytes.subarray(i, i + 13));
          i += 13;
          setImmediate(tick);
        };
        tick();
      } else if (req.url === '/base/slow') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: ping\ndata: {}\n\n');
      } else if (req.url === '/base/responses') {
        // Like the ChatGPT backend: usage arrives, then the stream lingers open.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-x","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60},"output_tokens":5}}}\n\n',
        );
      } else {
        res.writeHead(418, { 'content-type': 'application/json', 'x-upstream': 'yes' });
        res.end('{"error":"teapot"}');
      }
    });
  });
  const upPort = await listen(upstream);
  ledgerDir = mkdtempSync(join(tmpdir(), 'toonarrow-ledger-'));
  captureDir = mkdtempSync(join(tmpdir(), 'toonarrow-capture-'));
  const config: Config = { ...DEFAULT_CONFIG, capture: 'meta', compress: { bash: true, skills: true, keepSkills: ['code'] }, upstreams: { fake: `http://127.0.0.1:${upPort}/base`, dead: 'http://127.0.0.1:1' } };
  proxy = createProxyServer({ config, ledger: new Ledger(ledgerDir), captureDir });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

after(() => {
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  proxy.close();
  upstream.close();
});

async function ledgerEntries(): Promise<LedgerEntry[]> {
  // Ledger appends are fire-and-forget after the response ends.
  await new Promise((r) => setTimeout(r, 50));
  return new Ledger(ledgerDir).read(1);
}

test('streams an Anthropic response byte-identical and records usage', async () => {
  const reqBody = JSON.stringify({ model: 'claude-x', stream: true, messages: [], metadata: { user_id: JSON.stringify({ session_id: 's-1' }) } });
  const res = await fetch(`${proxyUrl}/fake/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', 'accept-encoding': 'gzip, br', 'user-agent': 'claude-cli/9.9.9 (x)' },
    body: reqBody,
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ANTHROPIC_SSE);

  assert.equal(lastSeen.url, '/base/v1/messages?beta=true');
  assert.equal(lastSeen.body, reqBody);
  assert.equal(lastSeen.headers.authorization, 'Bearer secret');
  assert.equal(lastSeen.headers['accept-encoding'], 'identity');

  const entry = (await ledgerEntries()).find((e) => e.path === '/base/v1/messages');
  assert.ok(entry);
  assert.equal(entry.status, 200);
  assert.equal(entry.wire, 'anthropic-messages');
  assert.equal(entry.sessionKey, 's-1');
  assert.equal(entry.client, 'claude-cli/9.9.9');
  assert.deepEqual(entry.usage, { input: 3, cacheRead: 900, cacheWrite: 10, output: 7, reasoning: 0 });

  const captured = readdirSync(captureDir).map((f) => readFileSync(join(captureDir, f), 'utf8')).join('\n');
  assert.ok(captured.includes('"authorization": "<redacted>"'));
  assert.ok(!captured.includes('secret'));
});

test('compresses Bash tool results before forwarding and records the saving', async () => {
  const ls = ['total 1', ...Array.from({ length: 30 }, (_, i) => `-rw-r--r--@  1 andrea  staff  ${1000 + i} 24 set 09:10 file-${i}.ts`)].join('\n');
  const reqBody = JSON.stringify({
    model: 'claude-x',
    stream: true,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: ls }] },
    ],
  });
  const res = await fetch(`${proxyUrl}/fake/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: reqBody });
  await res.text();
  const forwarded = JSON.parse(lastSeen.body);
  assert.ok(forwarded.messages[1].content[0].content.includes('[toonarrow ls-long:'));
  assert.equal(Number(lastSeen.headers['content-length']), Buffer.byteLength(lastSeen.body));
  const entry = (await ledgerEntries()).reverse().find((e) => e.compression);
  assert.ok(entry?.compression);
  assert.equal(entry.compression.bashBlocks, 1);
});

test('lists unused skills by id only and records the saving', async () => {
  const skill = (id: string): string => `  <skill>\n    <id>${id}</id>\n    <name>${id}</name>\n    <description>Use for ${id} tasks.</description>\n  </skill>\n`;
  const system = `Skills.\n<available_skills>\n${skill('code')}${skill('xlsx')}</available_skills>\nTail`;
  const reqBody = JSON.stringify({ model: 'glm', stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }] });
  const res = await fetch(`${proxyUrl}/fake/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: reqBody });
  await res.text();
  const sent: string = JSON.parse(lastSeen.body).messages[0].content;
  assert.ok(sent.includes('<id>code</id>') && sent.includes('>xlsx</more_skills>') && !sent.includes('xlsx tasks'));
  const entry = (await ledgerEntries()).reverse().find((e) => e.skills);
  assert.equal(entry?.skills?.skillsHidden, 1);
  assert.equal(entry?.skills?.skillsCharsSaved, system.length - sent.length);
  assert.equal(entry?.sentBytes, Buffer.byteLength(lastSeen.body));
});

test('serves the dashboard page and its summary', async () => {
  const page = await fetch(`${proxyUrl}/_toonarrow/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('api/summary'));
  const redirect = await fetch(`${proxyUrl}/_toonarrow`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/_toonarrow/');
  const summary = (await (await fetch(`${proxyUrl}/_toonarrow/api/summary?days=7`)).json()) as { days: number; daily: unknown[]; totals: { requests: number } };
  assert.equal(summary.days, 7);
  assert.equal(summary.daily.length, 7);
  assert.ok(summary.totals.requests > 0);
});

test('/_via/ forwards to the target carried in the path (Kora CLI)', async () => {
  const port = new URL(`http://${(upstream.address() as AddressInfo).address}:${(upstream.address() as AddressInfo).port}`).port;
  const res = await fetch(`${proxyUrl}/_via/http/127.0.0.1:${port}/base/other?x=1`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 418);
  assert.equal(lastSeen.url, '/base/other?x=1');
  const entry = (await ledgerEntries()).reverse().find((e) => e.upstream.startsWith('via:'));
  assert.equal(entry?.upstream, `via:127.0.0.1:${port}`);
  assert.equal((await fetch(`${proxyUrl}/_via/ftp/h/x`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${proxyUrl}/_via/https/user@h/x`, { method: 'POST', body: '{}' })).status, 404);
});

test('/_via/ refuses targets pointing back at toonarrow', () => {
  const config = { ...DEFAULT_CONFIG, port: 48700 };
  assert.equal(resolveTarget(config, '/_via/http/127.0.0.1:48700/_via/https/h/v1/chat/completions'), undefined);
  assert.equal(resolveTarget(config, '/_via/http/LOCALHOST:48700/x'), undefined);
  assert.equal(resolveTarget(config, '/_via/https/h/v1/chat/completions')?.target.href, 'https://h/v1/chat/completions');
});

test('passes upstream errors through unchanged', async () => {
  const res = await fetch(`${proxyUrl}/fake/other`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 418);
  assert.equal(res.headers.get('x-upstream'), 'yes');
  assert.equal(await res.text(), '{"error":"teapot"}');
});

test('404 for unknown upstream, 502 for unreachable upstream', async () => {
  const unknown = await fetch(`${proxyUrl}/nope/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(unknown.status, 404);
  const dead = await fetch(`${proxyUrl}/dead/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(dead.status, 502);
  assert.equal(((await dead.json()) as { error: { type: string } }).error.type, 'toonarrow_proxy_error');
});

test('client abort mid-stream closes the upstream request and is recorded', async () => {
  const ac = new AbortController();
  const res = await fetch(`${proxyUrl}/fake/slow`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  ac.abort();
  const entry = (await ledgerEntries()).find((e) => e.path === '/base/slow');
  assert.ok(entry);
  assert.equal(entry.error, 'client closed before response finished');
});

test('usage already streamed is kept when the client hangs up early (Codex)', async () => {
  const ac = new AbortController();
  const res = await fetch(`${proxyUrl}/fake/responses`, { method: 'POST', body: '{"model":"gpt-x","stream":true}', signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const entry = (await ledgerEntries()).find((e) => e.path === '/base/responses');
  assert.ok(entry);
  assert.equal(entry.model, 'gpt-x');
  assert.deepEqual(entry.usage, { input: 40, cacheRead: 60, cacheWrite: 0, output: 5, reasoning: 0 });
  assert.equal(entry.clientClosedEarly, true);
  assert.equal(entry.error, undefined);
});

test('health endpoint announces the routes this build serves', async () => {
  const res = await fetch(`${proxyUrl}/_toonarrow/health`);
  const body = (await res.json()) as { ok: boolean; features: string[] };
  assert.equal(body.ok, true);
  assert.ok(body.features.includes('via'));
});

test('toonarrow errors are tagged: route errors were never forwarded', async () => {
  const unknown = await fetch(`${proxyUrl}/nope/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('x-toonarrow-error'), 'route');
  const dead = await fetch(`${proxyUrl}/dead/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(dead.headers.get('x-toonarrow-error'), 'upstream');
  const upstreamError = await fetch(`${proxyUrl}/fake/other`, { method: 'POST', body: '{}' });
  assert.equal(upstreamError.headers.get('x-toonarrow-error'), null, 'provider errors pass through untagged');
});
