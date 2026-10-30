/**
 * Byte-preserving JSON edits. `JSON.parse` + `JSON.stringify` would rewrite escapes (Go's `<`), number formats
 * and key order details; these helpers only touch the bytes they mean to change.
 */

const WS = new Set([' ', '\t', '\n', '\r']);

/** End index (exclusive) of the string token starting at `i` (a `"`). */
function stringEnd(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

/** End index (exclusive) of the value starting at `i`, or -1. */
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') return stringEnd(text, i);
  if (text[i] === '{' || text[i] === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (c === '"') {
        j = stringEnd(text, j) - 1;
        if (j < 0) return -1;
      } else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < text.length && !WS.has(text[j]!) && text[j] !== ',' && text[j] !== '}' && text[j] !== ']') j++;
  return j > i ? j : -1;
}

const skipWs = (text: string, i: number): number => {
  while (i < text.length && WS.has(text[i]!)) i++;
  return i;
};

/**
 * Raw spans of the top-level string values of a JSON object, by key. Undefined when `text` is not a JSON object.
 * Duplicate keys keep the last span, as `JSON.parse` keeps the last value.
 */
export function topLevelStringSpans(text: string): Map<string, [number, number]> | undefined {
  let i = skipWs(text, 0);
  if (text[i] !== '{') return undefined;
  const spans = new Map<string, [number, number]>();
  i = skipWs(text, i + 1);
  if (text[i] === '}') return skipWs(text, i + 1) === text.length ? spans : undefined;
  for (;;) {
    if (text[i] !== '"') return undefined;
    const keyEnd = stringEnd(text, i);
    if (keyEnd < 0) return undefined;
    let key: string;
    try {
      key = JSON.parse(text.slice(i, keyEnd)) as string;
    } catch {
      return undefined;
    }
    i = skipWs(text, keyEnd);
    if (text[i] !== ':') return undefined;
    i = skipWs(text, i + 1);
    const end = valueEnd(text, i);
    if (end < 0) return undefined;
    if (text[i] === '"') spans.set(key, [i, end]);
    else spans.delete(key);
    i = skipWs(text, end);
    if (text[i] === ',') {
      i = skipWs(text, i + 1);
      continue;
    }
    if (text[i] === '}') return skipWs(text, i + 1) === text.length ? spans : undefined;
    return undefined;
  }
}

/**
 * Replaces top-level string fields of a JSON object in place, leaving every other byte as it was.
 * `edit` receives each requested field's decoded value and returns the new value (or the same one).
 * Returns `text` unchanged when it is not a JSON object or no field changed.
 */
export function editTopLevelStrings(text: string, keys: readonly string[], edit: (key: string, value: string) => string): string {
  const spans = topLevelStringSpans(text);
  if (!spans) return text;
  const changes: Array<[number, number, string]> = [];
  for (const key of keys) {
    const span = spans.get(key);
    if (!span) continue;
    let value: string;
    try {
      value = JSON.parse(text.slice(span[0], span[1])) as string;
    } catch {
      return text;
    }
    const next = edit(key, value);
    if (next !== value) changes.push([span[0], span[1], JSON.stringify(next)]);
  }
  if (!changes.length) return text;
  changes.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end, raw] of changes) out = out.slice(0, start) + raw + out.slice(end);
  return out;
}

/** Removes whitespace outside strings: lossless for JSON; undefined when `text` is not valid JSON. */
export function minifyJson(text: string): string | undefined {
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') i = stringEnd(text, i) - 1;
    else if (WS.has(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.join('');
}
