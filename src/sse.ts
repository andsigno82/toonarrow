export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental Server-Sent Events parser (WHATWG event-stream format). */
export class SseParser {
  #decoder = new TextDecoder();
  #buf = '';
  #event = '';
  #data: string[] = [];
  #onEvent: (ev: SseEvent) => void;

  constructor(onEvent: (ev: SseEvent) => void) {
    this.#onEvent = onEvent;
  }

  push(chunk: Uint8Array): void {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#line(line);
    }
  }

  end(): void {
    this.#buf += this.#decoder.decode();
    if (this.#buf) this.#line(this.#buf);
    this.#buf = '';
    this.#line('');
  }

  #line(line: string): void {
    if (line === '') {
      if (this.#data.length) this.#onEvent({ event: this.#event || 'message', data: this.#data.join('\n') });
      this.#event = '';
      this.#data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
  }
}
