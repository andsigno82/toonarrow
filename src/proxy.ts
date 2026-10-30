import http from 'node:http';
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Ledger, LedgerEntry } from './ledger.ts';
import { bodyShape, parseRequestJson, redactHeaders, requestMeta } from './meta.ts';
import { rewriteAnthropic, rewriteChat, rewriteResponses } from './compress/request.ts';
import type { RewriteStats } from './compress/request.ts';
import { rewriteSkills } from './compress/skills.ts';
import type { SessionMemoStore } from './session-memo.ts';
import type { SkillStats } from './compress/skills.ts';
import { DASHBOARD_HTML } from './dashboard.ts';
import { summarize } from './report.ts';
import { createCollector } from './usage.ts';
import type { CollectedUsage, UsageCollector } from './usage.ts';
import { detectWire } from './wire.ts';

export const VERSION = '0.1.0';

export interface ProxyOptions {
  config: Config;
  ledger: Ledger;
  /** Directory for capture files; required when config.capture !== 'off'. */
  captureDir?: string;
  /** Per-session memo of compression decisions; without it every request follows the current rules. */
  memo?: SessionMemoStore;
  log?: (msg: string) => void;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) plus host, which is rewritten for the upstream.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

function forwardHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

/** Routes this build serves, announced by /_toonarrow/health so clients can tell an older toonarrow apart. */
export const FEATURES = ['via'];

/**
 * Errors produced by toonarrow itself carry `x-toonarrow-error`: `route` means nothing was forwarded (unknown upstream
 * or path), so a client may safely resend the request directly; `upstream` and `internal` may have been forwarded.
 */
type ProxyErrorKind = 'route' | 'upstream' | 'internal';

function sendProxyError(res: ServerResponse, status: number, kind: ProxyErrorKind, message: string): void {
  sendJson(res, status, proxyError(message), { 'x-toonarrow-error': kind });
}

const CAPTURE_TAIL_BYTES = 32 * 1024;

/** A 2xx stream that carried an error event (e.g. a gateway 429 relayed inside the stream) failed all the same. */
const streamErrorText = (message: string): string => `stream error: ${message}`;

const proxyError = (message: string) => ({ type: 'error', error: { type: 'toonarrow_proxy_error', message } });

/**
 * Splits "/<upstream>/<rest>" into the upstream name and the target URL. "/_via/<scheme>/<host>/<rest>" carries
 * the target in the path, for clients whose providers are not known in advance (Kora CLI, KORA_LLM_PROXY).
 */
export function resolveTarget(config: Config, rawUrl: string): { upstream: string; target: URL } | undefined {
  const url = new URL(rawUrl, 'http://toonarrow.local');
  const [, name = '', ...rest] = url.pathname.split('/');
  if (name === '_via') {
    const [scheme, host = '', ...path] = rest;
    if ((scheme !== 'https' && scheme !== 'http') || !host || host.includes('@')) return undefined;
    // A target pointing back at toonarrow would rewrite the same body twice: refused.
    if ([`${config.host}:${config.port}`, `localhost:${config.port}`].includes(host.toLowerCase())) return undefined;
    return { upstream: `via:${host}`, target: new URL(`${scheme}://${host}/${path.join('/')}${url.search}`) };
  }
  const base = config.upstreams[name];
  if (!base) return undefined;
  return { upstream: name, target: new URL(base.replace(/\/+$/, '') + '/' + rest.join('/') + url.search) };
}

export function createProxyServer(opts: ProxyOptions): http.Server {
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const log = opts.log ?? (() => {});
  const keepSkills: ReadonlySet<string> = new Set(opts.config.compress.keepSkills);
  let captureSeq = 0;

  async function capture(entry: Record<string, unknown>): Promise<void> {
    if (opts.config.capture === 'off' || !opts.captureDir) return;
    await mkdir(opts.captureDir, { recursive: true });
    const name = `${Date.now()}-${String(++captureSeq).padStart(5, '0')}.json`;
    await writeFile(join(opts.captureDir, name), JSON.stringify(entry, null, 1));
  }

  /** Local dashboard: the page at /_toonarrow/ and its data at /_toonarrow/api/summary?days=N. */
  async function serveDashboard(rawUrl: string, res: ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://toonarrow.local');
    if (url.pathname === '/_toonarrow') {
      res.writeHead(301, { location: '/_toonarrow/' });
      return void res.end();
    }
    if (url.pathname === '/_toonarrow/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(DASHBOARD_HTML);
    }
    if (url.pathname === '/_toonarrow/api/summary') {
      const days = Math.min(365, Math.max(1, Math.floor(Number(url.searchParams.get('days')) || 30)));
      return sendJson(res, 200, summarize(await opts.ledger.read(days), days));
    }
    sendProxyError(res, 404, 'route', `unknown toonarrow path: ${url.pathname}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    if (rawUrl === '/_toonarrow/health') return sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid, features: FEATURES });
    if (rawUrl.startsWith('/_toonarrow')) return serveDashboard(rawUrl, res);

    const resolved = resolveTarget(opts.config, rawUrl);
    if (!resolved) return sendProxyError(res, 404, 'route', `unknown upstream in path: ${rawUrl.split('?')[0]}`);
    const { upstream, target } = resolved;

    const started = performance.now();
    const original = await readBody(req);
    const wire = detectWire(target.pathname);
    const json = wire === 'other' ? undefined : parseRequestJson(original, req.headers);
    const meta = requestMeta(wire, req.headers, json);
    const headers = forwardHeaders(req.headers);

    const fullCapture = opts.config.capture === 'full' && json ? structuredClone(json) : undefined;
    // Blocks already sent in this session keep the bytes they had then, whatever the rules and config are now.
    const memo = json && meta.sessionKey ? opts.memo?.for(meta.sessionKey) : undefined;
    let compression: RewriteStats | undefined;
    if (json && opts.config.compress.bash) {
      if (wire === 'anthropic-messages') compression = rewriteAnthropic(json, memo);
      else if (wire === 'openai-responses') compression = rewriteResponses(json, memo);
      else if (wire === 'openai-chat') compression = rewriteChat(json, memo);
    }
    const skills: SkillStats | undefined =
      json && opts.config.compress.skills ? rewriteSkills(json, wire, memo ? memo.keepSkills(keepSkills) : keepSkills) : undefined;
    // Only re-serialize when something changed; the body is then sent uncompressed.
    const body = compression?.bashBlocks || skills?.skillsHidden ? Buffer.from(JSON.stringify(json)) : original;
    if (body !== original) delete headers['content-encoding'];
    // Identity responses keep the usage collector able to read the bytes it tees.
    headers['accept-encoding'] = 'identity';
    headers['content-length'] = String(body.length);

    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      upstream,
      method: req.method ?? 'GET',
      path: target.pathname,
      wire,
      status: 0,
      durationMs: 0,
      requestBytes: original.length,
      ...(body !== original ? { sentBytes: body.length } : {}),
      ...meta,
      ...(compression?.bashBlocks ? { compression } : {}),
      ...(skills?.skillsHidden ? { skills } : {}),
    };
    let recorded = false;
    const record = (patch: Partial<LedgerEntry>): void => {
      if (recorded) return;
      recorded = true;
      Object.assign(entry, patch, { durationMs: Math.round(performance.now() - started) });
      opts.ledger.append(entry).catch((e) => log(`ledger write failed: ${e}`));
    };

    capture({ ts: entry.ts, upstream, method: entry.method, url: target.href, wire, headers: redactHeaders(req.headers), shape: bodyShape(json), meta, compression, skills, body: fullCapture }).catch(
      (e) => log(`capture write failed: ${e}`),
    );

    // Usage seen so far; also read on early client close (Codex hangs up right after response.completed).
    let collector: UsageCollector | null = null;
    let collected: CollectedUsage | undefined;
    const usageSoFar = (): CollectedUsage => (collected ??= collector?.finish() ?? {});

    const client = target.protocol === 'https:' ? https : http;
    const upReq = client.request(target, { method: req.method, headers, agent: target.protocol === 'https:' ? agents.https : agents.http });

    upReq.on('response', (upRes) => {
      const status = upRes.statusCode ?? 502;
      res.writeHead(status, forwardHeaders(upRes.headers));
      const encoded = (upRes.headers['content-encoding'] ?? 'identity') !== 'identity';
      collector = status < 400 && !encoded ? createCollector(wire, upRes.headers['content-type'], meta.stream) : null;
      if (collector) {
        const c = collector;
        upRes.on('data', (chunk: Buffer) => c.push(chunk));
      }
      upRes.pipe(res);
      const responseCapture = { ts: new Date().toISOString(), response: target.href, status, headers: redactHeaders(upRes.headers), collector: collector !== null };
      // Full capture also keeps the tail of the response body, where streams carry usage (protocol discovery).
      let tail: Buffer[] | undefined;
      if (opts.config.capture === 'full') {
        tail = [];
        let size = 0;
        upRes.on('data', (chunk: Buffer) => {
          tail!.push(chunk);
          size += chunk.length;
          while (size - tail![0]!.length > CAPTURE_TAIL_BYTES) size -= tail!.shift()!.length;
        });
      } else {
        capture(responseCapture).catch((e) => log(`capture write failed: ${e}`));
      }
      upRes.on('end', () => {
        if (tail) capture({ ...responseCapture, bodyTail: Buffer.concat(tail).toString('utf8') }).catch((e) => log(`capture write failed: ${e}`));
        const got = usageSoFar();
        record({ status, model: got.model ?? entry.model, usage: got.usage, ...(got.streamError ? { error: streamErrorText(got.streamError) } : {}) });
      });
      upRes.on('error', (err) => {
        record({ status, error: `upstream response: ${err.message}` });
        res.destroy(err);
      });
    });

    upReq.on('error', (err) => {
      record({ status: 502, error: `upstream request: ${err.message}` });
      if (!res.headersSent) sendProxyError(res, 502, 'upstream', `upstream ${upstream} unreachable: ${err.message}`);
      else res.destroy(err);
    });

    // Client went away mid-stream: stop paying for tokens nobody will read.
    res.on('close', () => {
      if (!res.writableFinished) {
        upReq.destroy();
        const got = usageSoFar();
        // Normal for Codex once usage has arrived; an error only when nothing billable was seen.
        record({
          status: res.statusCode,
          model: got.model ?? entry.model,
          usage: got.usage,
          clientClosedEarly: true,
          error: got.streamError ? streamErrorText(got.streamError) : got.usage ? undefined : 'client closed before response finished',
        });
      }
    });

    upReq.end(body);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log(`request failed: ${err.stack ?? err}`);
      if (!res.headersSent) sendProxyError(res, 500, 'internal', err.message);
      else res.destroy(err);
    });
  });
}
