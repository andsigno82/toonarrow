import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { newResponsesState, rewriteResponses } from '../src/compress/request.ts';
import { Ledger } from '../src/ledger.ts';
import type { LedgerEntry } from '../src/ledger.ts';
import { createProxyServer } from '../src/proxy.ts';
import { SessionMemoStore } from '../src/session-memo.ts';

type Json = Record<string, any>;

const LS_OUTPUT = ['total 2048', ...Array.from({ length: 30 }, (_, i) => `-rw-r--r--@  1 andrea  staff  ${1000 + i} 24 set 09:10 file-${i}.ts`)].join('\n');
const EXEC_CALL = { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"ls -la"}));\n' };
const toolOutput = () => ({ type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: `Script completed\nOutput:\n${LS_OUTPUT}` }] });

// Codex 0.166.0 over the ChatGPT backend: warmup (generate:false, no input), a turn with the conversation, then a turn
// carrying only the tool output, each chained with previous_response_id.
const warmup = { type: 'response.create', model: 'gpt-test', stream: true, store: false, input: [], generate: false };
const firstTurn = { type: 'response.create', model: 'gpt-test', stream: true, store: false, previous_response_id: 'resp_1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }] };
const outputTurn = () => ({ type: 'response.create', model: 'gpt-test', stream: true, store: false, previous_response_id: 'resp_2', input: [toolOutput()] });

const listen = (s: http.Server): Promise<number> => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));

let upstream: http.Server;
let proxy: http.Server;
let proxyPort: number;
let ledgerDir: string;
const received: Json[] = [];
const serverEvents: string[] = [];
let handshake: IncomingHttpHeaders = {};

before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  upstream = http.createServer((_req, res) => res.writeHead(404).end());
  upstream.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/deny')) return void socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
    handshake = req.headers;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        const id = `resp_${received.length}`;
        const send = (ev: Json): void => {
          const raw = JSON.stringify(ev);
          serverEvents.push(raw);
          ws.send(raw);
        };
        send({ type: 'response.created', response: { id } });
        if (msg.input.some((i: Json) => i.type === 'message')) send({ type: 'response.output_item.done', item: EXEC_CALL });
        send({ type: 'response.output_text.delta', delta: 'ok' });
        send({ type: 'response.completed', response: { id, model: 'gpt-test', usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } } } });
      });
    });
  });
  const upPort = await listen(upstream);
  ledgerDir = mkdtempSync(join(tmpdir(), 'toonarrow-ws-ledger-'));
  const config: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    upstreams: { fake: `http://127.0.0.1:${upPort}`, deny: `http://127.0.0.1:${upPort}/deny` },
  };
  proxy = createProxyServer({ config, ledger: new Ledger(ledgerDir), memo: new SessionMemoStore(mkdtempSync(join(tmpdir(), 'toonarrow-ws-memo-'))) });
  proxyPort = await listen(proxy);
});

after(() => {
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  proxy.close();
  upstream.close();
});

/** Sends each message after the previous turn completed; resolves with every server event the client got. */
async function conversation(path: string, messages: Json[]): Promise<string[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`, { headers: { 'session-id': 'sess-ws', authorization: 'Bearer test' } });
  const got: string[] = [];
  await new Promise<void>((resolve, reject) => {
    let next = 0;
    const send = (): void => (next < messages.length ? ws.send(JSON.stringify(messages[next++])) : ws.close(1000));
    ws.on('open', send);
    ws.on('message', (data) => {
      got.push(data.toString());
      if (JSON.parse(data.toString()).type === 'response.completed') send();
    });
    ws.on('close', () => resolve());
    ws.on('error', reject);
  });
  return got;
}

async function waitForLedger(count: number): Promise<LedgerEntry[]> {
  for (let i = 0; i < 100; i++) {
    const entries = (await new Ledger(ledgerDir).read(1)).filter((e) => e.transport === 'websocket');
    if (entries.length >= count) return entries;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('ledger entries missing');
}

test('websocket: compresses a tool output whose call came from the server, relays server events untouched', async () => {
  const got = await conversation('/fake/responses', [warmup, firstTurn, outputTurn()]);
  assert.deepEqual(got, serverEvents, 'server events reach the client byte for byte, in order');
  assert.equal(handshake.authorization, 'Bearer test');
  assert.equal(handshake['session-id'], 'sess-ws');
  assert.equal(handshake['sec-websocket-extensions'], undefined, 'no permessage-deflate towards the upstream');

  assert.deepEqual(received[0], warmup);
  assert.deepEqual(received[1], firstTurn);
  const sent = received[2]!.input[0].output[0].text as string;
  assert.ok(sent.includes('[toonarrow ls-long:'), 'tool output compressed');
  assert.ok(sent.length < toolOutput().output[0]!.text.length);

  // Same bytes as the HTTP path over the full history, and a second pass changes nothing.
  const viaHttp: Json = { input: [EXEC_CALL, toolOutput()] };
  rewriteResponses(viaHttp);
  assert.equal(sent, viaHttp.input[1].output[0].text);
  const again = structuredClone(received[2]!);
  const state = newResponsesState();
  state.calls.set('c1', [{ cmd: 'ls -la' }]);
  assert.equal(rewriteResponses(again, undefined, state).bashBlocks, 0);
  assert.deepEqual(again, received[2]);

  const entries = await waitForLedger(3);
  // Normalized usage: input excludes the 40 cached tokens.
  assert.deepEqual(entries.map((e) => [e.method, e.status, e.sessionKey, e.usage?.input, e.usage?.cacheRead]), [
    ['WS', 200, 'sess-ws', 60, 40],
    ['WS', 200, 'sess-ws', 60, 40],
    ['WS', 200, 'sess-ws', 60, 40],
  ]);
  assert.equal(entries[2]!.compression?.bashBlocks, 1);
  assert.ok(entries[2]!.sentBytes! < entries[2]!.requestBytes);
  assert.equal(entries[0]!.compression, undefined);
});

const upgradeStatus = (path: string): Promise<{ status: number; kind: string | undefined }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`);
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0, kind: res.headers['x-toonarrow-error'] as string | undefined });
      res.resume();
    });
    ws.on('open', () => reject(new Error('upgrade accepted')));
    ws.on('error', () => {});
  });

test('websocket: a refused upstream socket answers 426 so the client falls back to HTTPS', async () => {
  assert.deepEqual(await upgradeStatus('/deny/responses'), { status: 426, kind: 'upstream' });
});

test('websocket: only Responses API paths of known upstreams are relayed', async () => {
  assert.deepEqual(await upgradeStatus('/fake/v1/realtime'), { status: 426, kind: 'route' });
  assert.deepEqual(await upgradeStatus('/nope/responses'), { status: 404, kind: 'route' });
  assert.deepEqual(await upgradeStatus('/_toonarrow/health'), { status: 404, kind: 'route' });
});
