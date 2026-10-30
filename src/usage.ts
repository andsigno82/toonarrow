import { SseParser } from './sse.ts';
import type { Wire } from './wire.ts';

/**
 * Provider-neutral token usage. `input` excludes cached tokens on every wire, so
 * input + cacheRead + cacheWrite is the full prompt size.
 */
export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface CollectedUsage {
  model?: string;
  usage?: Usage;
  /** First error event inside a stream whose HTTP status was 2xx (e.g. a gateway 429 relayed by kora-server). */
  streamError?: string;
}

export interface UsageCollector {
  push(chunk: Uint8Array): void;
  finish(): CollectedUsage;
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;

type Json = Record<string, any>;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normalizeAnthropic(u: Json): Usage {
  return {
    input: num(u.input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    output: num(u.output_tokens),
    reasoning: 0,
  };
}

export function normalizeResponses(u: Json): Usage {
  const cached = num(u.input_tokens_details?.cached_tokens);
  return {
    input: num(u.input_tokens) - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: num(u.output_tokens),
    reasoning: num(u.output_tokens_details?.reasoning_tokens),
  };
}

export function normalizeChat(u: Json): Usage {
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  return {
    input: num(u.prompt_tokens) - cached,
    cacheRead: cached,
    cacheWrite: 0,
    output: num(u.completion_tokens),
    reasoning: num(u.completion_tokens_details?.reasoning_tokens),
  };
}

/** Extracts model + usage from a complete (non-streaming) JSON response body. */
export function usageFromBody(wire: Wire, body: Json): CollectedUsage {
  const model = typeof body.model === 'string' ? body.model : undefined;
  if (!body.usage || typeof body.usage !== 'object') return { model };
  if (wire === 'anthropic-messages') return { model, usage: normalizeAnthropic(body.usage) };
  if (wire === 'openai-responses') return { model, usage: normalizeResponses(body.usage) };
  if (wire === 'openai-chat') return { model, usage: normalizeChat(body.usage) };
  return { model };
}

function parseJson(data: string): Json | undefined {
  try {
    const v = JSON.parse(data);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Error carried by one stream event: Anthropic `error`, Responses `error`/`response.failed`, Chat `{error}`. */
export function streamErrorOf(wire: Wire, ev: Json): string | undefined {
  const e =
    wire === 'anthropic-messages'
      ? ev.type === 'error' ? ev.error : undefined
      : wire === 'openai-responses'
        ? ev.type === 'error' ? (ev.error ?? ev) : ev.type === 'response.failed' ? ev.response?.error : undefined
        : ev.error;
  if (!e) return undefined;
  const message = typeof e === 'string' ? e : typeof e.message === 'string' ? e.message : JSON.stringify(e);
  return message.slice(0, 300);
}

function streamCollector(wire: Wire): UsageCollector {
  const result: CollectedUsage = {};
  // Anthropic splits usage across message_start (prompt side) and message_delta (cumulative output).
  let anthropicRaw: Json = {};

  const parser = new SseParser(({ data }) => {
    if (data === '[DONE]') return;
    const ev = parseJson(data);
    if (!ev) return;
    if (!result.streamError) {
      const error = streamErrorOf(wire, ev);
      if (error) result.streamError = error;
    }
    if (wire === 'anthropic-messages') {
      if (ev.type === 'message_start' && ev.message) {
        result.model = ev.message.model;
        anthropicRaw = { ...ev.message.usage };
      } else if (ev.type === 'message_delta' && ev.usage) {
        for (const [k, v] of Object.entries(ev.usage)) if (v != null) anthropicRaw[k] = v;
      } else return;
      result.usage = normalizeAnthropic(anthropicRaw);
    } else if (wire === 'openai-responses') {
      const r = ev.response;
      if (!r || !['response.completed', 'response.incomplete', 'response.failed'].includes(ev.type)) return;
      result.model = r.model;
      if (r.usage) result.usage = normalizeResponses(r.usage);
    } else if (wire === 'openai-chat') {
      if (typeof ev.model === 'string') result.model = ev.model;
      if (ev.usage) result.usage = normalizeChat(ev.usage);
    }
  });

  return {
    push: (chunk) => parser.push(chunk),
    finish: () => {
      parser.end();
      return result;
    },
  };
}

function jsonCollector(wire: Wire): UsageCollector {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    push(chunk) {
      size += chunk.length;
      if (size <= MAX_JSON_BYTES) chunks.push(chunk);
    },
    finish() {
      if (size > MAX_JSON_BYTES) return {};
      const body = parseJson(Buffer.concat(chunks).toString('utf8'));
      return body ? usageFromBody(wire, body) : {};
    },
  };
}

/**
 * Returns null when the response cannot carry usage we know how to read. `streamRequested`
 * decides when content-type is missing (the ChatGPT Codex backend sends none).
 */
export function createCollector(wire: Wire, contentType: string | undefined, streamRequested?: boolean): UsageCollector | null {
  if (wire === 'other') return null;
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return streamCollector(wire);
  if (ct.includes('application/json')) return jsonCollector(wire);
  if (!ct && streamRequested !== undefined) return streamRequested ? streamCollector(wire) : jsonCollector(wire);
  return null;
}
