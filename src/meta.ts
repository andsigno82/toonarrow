import type { IncomingHttpHeaders } from 'node:http';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import type { Wire } from './wire.ts';

export interface RequestMeta {
  model?: string;
  stream?: boolean;
  /** Best-effort conversation identity; the source field is recorded alongside it. */
  sessionKey?: string;
  sessionSource?: string;
  client?: string;
}

type Json = Record<string, any>;

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

export function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? 'identity').toLowerCase()) {
    case 'identity':
      return body;
    case 'gzip':
      return gunzipSync(body);
    case 'deflate':
      return inflateSync(body);
    case 'br':
      return brotliDecompressSync(body);
    case 'zstd':
      return zstdDecompressSync(body);
    default:
      throw new Error(`unsupported content-encoding: ${encoding}`);
  }
}

export function parseRequestJson(body: Buffer, headers: IncomingHttpHeaders): Json | undefined {
  if (!body.length) return undefined;
  try {
    const v = JSON.parse(decodeBody(body, header(headers, 'content-encoding')).toString('utf8'));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function claudeUserIdSession(userId: string): string | undefined {
  // Claude Code 2.1.x: metadata.user_id is a JSON string {device_id, account_uuid, session_id}.
  try {
    const parsed = JSON.parse(userId);
    if (typeof parsed?.session_id === 'string') return parsed.session_id;
  } catch {
    // Older clients: "user_<hash>_account_<uuid>_session_<uuid>".
  }
  return /session_([0-9a-f-]{36})/i.exec(userId)?.[1];
}

// Candidate session identifiers, most specific first.
// Verified on Claude Code 2.1.312, Codex 0.160.1 and OpenCode 2.2.0 (documentation/architecture.md).
function sessionOf(headers: IncomingHttpHeaders, body: Json | undefined): [string, string] | undefined {
  const claudeHeader = header(headers, 'x-claude-code-session-id');
  if (claudeHeader) return [claudeHeader, 'header:x-claude-code-session-id'];
  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string') {
    const session = claudeUserIdSession(userId);
    if (session) return [session, 'body:metadata.user_id'];
  }
  const codexHeader = header(headers, 'session_id') ?? header(headers, 'session-id');
  if (codexHeader) return [codexHeader, 'header:session_id'];
  // Kora (OpenAI-compatible providers) sends its own session id as an extra body field. It wins over
  // x-opencode-session-id, which Kora also sends when the user configured that session-header rule.
  if (typeof body?.session_id === 'string') return [body.session_id, 'body:session_id'];
  const opencodeHeader = header(headers, 'x-opencode-session-id') ?? header(headers, 'x-opencode-session');
  if (opencodeHeader) return [opencodeHeader, 'header:x-opencode-session-id'];
  if (typeof body?.prompt_cache_key === 'string') return [body.prompt_cache_key, 'body:prompt_cache_key'];
  return undefined;
}

export function requestMeta(_wire: Wire, headers: IncomingHttpHeaders, body: Json | undefined): RequestMeta {
  const session = sessionOf(headers, body);
  return {
    model: typeof body?.model === 'string' ? body.model : undefined,
    stream: typeof body?.stream === 'boolean' ? body.stream : undefined,
    sessionKey: session?.[0],
    sessionSource: session?.[1],
    client: header(headers, 'user-agent')?.split(' ')[0],
  };
}

const SECRET_HEADER = /auth|key|cookie|token|secret|account/i;

export function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = SECRET_HEADER.test(k) ? '<redacted>' : Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Structural summary of a request body: keys and sizes, never message content. */
export function bodyShape(body: Json | undefined): Json | undefined {
  if (!body) return undefined;
  const shape: Json = { keys: Object.keys(body).sort() };
  for (const k of ['messages', 'input', 'tools', 'system']) {
    const v = body[k];
    if (Array.isArray(v)) shape[`${k}.length`] = v.length;
    else if (typeof v === 'string') shape[`${k}.chars`] = v.length;
  }
  if (body.metadata && typeof body.metadata === 'object') shape.metadataKeys = Object.keys(body.metadata);
  return shape;
}
