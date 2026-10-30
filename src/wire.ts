/** API dialect of a request, detected from the path the client called. */
export type Wire = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'other';

export function detectWire(pathname: string): Wire {
  const p = pathname.replace(/\/+$/, '');
  if (p.endsWith('/messages')) return 'anthropic-messages';
  if (p.endsWith('/responses')) return 'openai-responses';
  if (p.endsWith('/chat/completions')) return 'openai-chat';
  return 'other';
}
