import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket } from 'ws';
import type { Config } from './config.ts';
import { newResponsesState, responsesCall, rewrote } from './compress/request.ts';
import { type ProxyErrorKind, proxyError } from './errors.ts';
import type { Ledger, LedgerEntry } from './ledger.ts';
import { bodyShape, redactHeaders, requestMeta } from './meta.ts';
import { rewriteRequest } from './rewrite.ts';
import type { SessionMemoStore } from './session-memo.ts';
import { normalizeResponses, streamErrorOf } from './usage.ts';

/**
 * Responses API WebSocket mode (Codex): the client keeps one socket open and sends a `response.create` per turn with
 * only the new input items plus `previous_response_id`. toonarrow terminates the client's socket, opens its own to the
 * upstream and relays messages: `response.create` is rewritten like an HTTP Responses body, server events pass
 * through unchanged and are read for tool calls (a tool output arrives in a later turn than its call, which came from
 * the server) and usage. When the upstream refuses the socket the client gets 426 and falls back to HTTPS, which the
 * proxy compresses as well. Verified on Codex 0.166.0 against the ChatGPT backend (documentation/architecture.md).
 */

export interface SocketContext {
  config: Config;
  ledger: Ledger;
  memo?: SessionMemoStore;
  keepSkills: ReadonlySet<string>;
  capture(entry: Record<string, unknown>): Promise<void>;
  log(msg: string): void;
}

type Json = Record<string, any>;
type WsModule = typeof import('ws');

// Loaded on the first upgrade only: plain HTTP traffic never pays for it.
let wsModule: Promise<WsModule> | undefined;
const loadWs = (): Promise<WsModule> => (wsModule ??= import('ws'));

// Hop-by-hop and handshake headers: the upstream handshake is toonarrow's own.
const NOT_FORWARDED = /^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade|te|trailer|host|sec-websocket-.*)$/;

/** Answers an upgrade request with a plain HTTP error and closes the socket. */
export function refuseUpgrade(socket: Duplex, status: number, kind: ProxyErrorKind, message: string): void {
  if (!socket.writable) return void socket.destroy();
  const body = JSON.stringify(proxyError(message));
  socket.end(
    `HTTP/1.1 ${status} ${status === 426 ? 'Upgrade Required' : 'Error'}\r\nconnection: close\r\ncontent-type: application/json\r\n` +
      `x-toonarrow-error: ${kind}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** Close codes an endpoint may send (RFC 6455 §7.4); 1005/1006/1015 only describe how a socket ended. */
const sendableCode = (code: number): boolean => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

function closeLike(ws: WebSocket, code: number, reason: Buffer): void {
  if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return;
  if (sendableCode(code)) ws.close(code, reason.subarray(0, 123));
  else ws.close();
}

const text = (data: RawData): string => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');

function parseJson(raw: string): Json | undefined {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

// Server events read by toonarrow; the many delta events are relayed without parsing.
const READ_EVENTS = /"type"\s*:\s*"(?:response\.output_item\.done|response\.completed|response\.incomplete|response\.failed|error)"/;
const END_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);

/** Relays a Responses API WebSocket between the client and `target` (an http(s) URL, switched to ws(s)). */
export async function relayResponsesSocket(ctx: SocketContext, req: IncomingMessage, socket: Duplex, head: Buffer, upstream: string, target: URL): Promise<void> {
  let ws: WsModule;
  try {
    ws = await loadWs();
  } catch (e) {
    ctx.log(`websocket support unavailable (${e}); clients fall back to HTTPS`);
    return refuseUpgrade(socket, 426, 'internal', 'toonarrow: websocket support unavailable, use HTTPS');
  }
  const url = new URL(target);
  url.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !NOT_FORWARDED.test(k)) headers[k] = v;
  const protocols = req.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()).filter(Boolean);

  // No permessage-deflate on either leg: messages stay readable and the client accepts the refusal (RFC 7692 §5).
  const up = new ws.WebSocket(url, protocols ?? [], { headers, perMessageDeflate: false, handshakeTimeout: 30_000 });
  let settled = false;
  const refuse = (message: string): void => {
    if (settled) return;
    settled = true;
    ctx.log(`websocket ${upstream}${target.pathname}: ${message}; client falls back to HTTPS`);
    refuseUpgrade(socket, 426, 'upstream', `toonarrow: upstream websocket ${message}, use HTTPS`);
  };
  up.on('unexpected-response', (_r, res) => {
    res.resume();
    refuse(`refused with HTTP ${res.statusCode}`);
    up.terminate();
  });
  up.on('error', (e) => {
    if (!settled) refuse(`failed: ${e.message}`);
    else ctx.log(`websocket ${upstream}: upstream error: ${e.message}`);
  });
  socket.once('close', () => {
    if (!settled) up.terminate();
  });
  up.once('open', () => {
    if (settled || !socket.writable) return void up.terminate();
    settled = true;
    const server = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.handleUpgrade(req, socket, head, (client) => relay(ctx, req, client, up, upstream, target));
  });
}

interface Turn {
  entry: LedgerEntry;
  started: number;
}

function relay(ctx: SocketContext, req: IncomingMessage, client: WebSocket, up: WebSocket, upstream: string, target: URL): void {
  const wire = 'openai-responses';
  const state = newResponsesState();
  const turns: Turn[] = [];

  const finish = (turn: Turn, patch: Partial<LedgerEntry>): void => {
    Object.assign(turn.entry, patch, { durationMs: Math.round(performance.now() - turn.started) });
    ctx.ledger.append(turn.entry).catch((e) => ctx.log(`ledger write failed: ${e}`));
  };

  client.on('message', (data, isBinary) => {
    const raw = isBinary ? undefined : text(data);
    const json = raw === undefined ? undefined : parseJson(raw);
    if (!json || json.type !== 'response.create') return void up.send(data, { binary: isBinary });

    const meta = requestMeta(wire, req.headers, json);
    // Blocks already sent in this session keep the bytes they had then, whatever the rules and config are now.
    const memo = meta.sessionKey ? ctx.memo?.for(meta.sessionKey) : undefined;
    const fullCapture = ctx.config.capture === 'full' ? structuredClone(json) : undefined;
    const { compression, skills, changed } = rewriteRequest(json, wire, ctx.config.compress, ctx.keepSkills, memo, state);
    const sent = changed ? JSON.stringify(json) : raw!;
    up.send(sent);

    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      upstream,
      method: 'WS',
      path: target.pathname,
      wire,
      transport: 'websocket',
      status: 0,
      durationMs: 0,
      requestBytes: Buffer.byteLength(raw!),
      ...(changed ? { sentBytes: Buffer.byteLength(sent) } : {}),
      ...meta,
      stream: true,
      ...(rewrote(compression) ? { compression } : {}),
      ...(skills && (skills.skillsHidden > 0 || skills.skillsCharsSaved > 0) ? { skills } : {}),
    };
    turns.push({ entry, started: performance.now() });
    ctx
      .capture({ ts: entry.ts, upstream, method: 'WS', url: target.href, wire, headers: redactHeaders(req.headers), shape: bodyShape(json), meta, compression, skills, body: fullCapture })
      .catch((e) => ctx.log(`capture write failed: ${e}`));
  });

  up.on('message', (data, isBinary) => {
    client.send(data, { binary: isBinary });
    if (isBinary) return;
    const raw = text(data);
    if (!READ_EVENTS.test(raw)) return;
    const ev = parseJson(raw);
    if (!ev) return;
    if (ev.type === 'response.output_item.done' && ev.item && typeof ev.item.call_id === 'string') {
      const call = responsesCall(ev.item);
      if (call) state.calls.set(ev.item.call_id, call);
      return;
    }
    if (!END_EVENTS.has(ev.type)) return;
    const turn = turns.shift();
    if (!turn) return;
    const r = ev.response;
    const error = streamErrorOf(wire, ev);
    finish(turn, {
      status: 200,
      model: typeof r?.model === 'string' ? r.model : turn.entry.model,
      ...(r?.usage ? { usage: normalizeResponses(r.usage) } : {}),
      ...(error ? { error: `stream error: ${error}` } : {}),
    });
  });

  // Turns still open when the socket ends never got their usage.
  const flush = (why: string): void => {
    for (const turn of turns.splice(0)) finish(turn, { status: 200, clientClosedEarly: why === 'client', error: `${why} closed the websocket before the response finished` });
  };
  client.on('close', (code, reason) => {
    flush('client');
    closeLike(up, code, reason);
  });
  up.on('close', (code, reason) => {
    flush('upstream');
    closeLike(client, code, reason);
  });
  client.on('error', (e) => {
    ctx.log(`websocket ${upstream}: client error: ${e.message}`);
    up.terminate();
  });
  up.on('error', () => client.terminate());
}
