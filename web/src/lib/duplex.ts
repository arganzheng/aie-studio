// Model: web.Duplex ← server duplex.ts. A WebSocket-shaped connection to one of
// the server's /ws/* channels that falls back to plain HTTP when the network
// won't carry WebSockets (corporate proxies answering `403 WebSocketBlock`):
//
//   websocket  the real thing
//   sse        server→client over an EventSource, client→server over POST
//   poll       server→client over long polling, client→server over POST
//
// 'auto' tries the WebSocket first; once a WebSocket fails to open while HTTP
// works, the rest of this page load goes straight to HTTP. Inside HTTP, SSE is
// tried first; a proxy that holds the stream back (no `ready` event within
// SSE_READY_MS) sends this page load to long polling.

export type TransportPref = 'auto' | 'websocket' | 'sse' | 'poll';
export type Transport = 'websocket' | 'sse' | 'poll';

export const TRANSPORT_PREF_KEY = 'aie.transport';
export const TRANSPORT_OPTIONS: Array<{ value: TransportPref; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'WebSocket; falls back to HTTP when a proxy blocks it' },
  { value: 'websocket', label: 'WebSocket only', hint: 'Never fall back' },
  { value: 'sse', label: 'HTTP (streaming)', hint: 'Server-sent events + POST; falls back to polling if the stream is held back' },
  { value: 'poll', label: 'HTTP (long polling)', hint: 'Works through nearly any proxy; output arrives in chunks' },
];

const WS_OPEN_TIMEOUT_MS = 8_000;
const SSE_READY_MS = 4_000;
const POLL_WAIT_MS = 25_000;
const ACK_INTERVAL_MS = 15_000;
const MAX_HTTP_FAILURES = 5;

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

/** The subset of WebSocket the panels use. readyState values match WebSocket's. */
export type CloseInfo = { code?: number; reason?: string };

export interface DuplexSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: CloseInfo) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

// What this page load has learned about the network.
let wsBlocked = false;
let sseHeldBack = false;
let lastUsed: Transport | null = null;
// Streams still waiting for `ready`: once one proves SSE is held back, all switch at once.
const awaitingReady = new Set<() => void>();

export function readTransportPref(): TransportPref {
  try {
    const v = localStorage.getItem(TRANSPORT_PREF_KEY);
    if (v === 'websocket' || v === 'sse' || v === 'poll') return v;
  } catch {}
  return 'auto';
}

export function writeTransportPref(v: TransportPref): void {
  try {
    if (v === 'auto') localStorage.removeItem(TRANSPORT_PREF_KEY);
    else localStorage.setItem(TRANSPORT_PREF_KEY, v);
  } catch {}
}

/** The transport the most recent connection on this page ended up using. */
export function lastTransport(): Transport | null { return lastUsed; }

/** Test hook. */
export function _resetDuplexState(): void { wsBlocked = false; sseHeldBack = false; lastUsed = null; awaitingReady.clear(); }

/** Connect to `/ws/<channel>` with `query`, on the preferred transport. */
export function openDuplex(channel: string, query: string | URLSearchParams = '', pref: TransportPref = readTransportPref()): DuplexSocket {
  const qs = String(query);
  if (pref === 'websocket') return openWs(channel, qs);
  if (pref === 'sse' || pref === 'poll') return new HttpSocket(channel, qs, pref === 'sse' && !sseHeldBack);
  if (wsBlocked) return new HttpSocket(channel, qs, !sseHeldBack);
  return new AutoSocket(channel, qs);
}

function wsUrl(channel: string, qs: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/${channel}${qs ? `?${qs}` : ''}`;
}

function openWs(channel: string, qs: string): DuplexSocket {
  const ws = new WebSocket(wsUrl(channel, qs));
  ws.addEventListener('open', () => { lastUsed = 'websocket'; });
  return ws as unknown as DuplexSocket;
}

// Shared event plumbing for the two wrapper classes.
abstract class Base implements DuplexSocket {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: CloseInfo) => void) | null = null;
  onerror: (() => void) | null = null;
  abstract send(data: string): void;
  abstract close(): void;
  protected fireOpen() { this.readyState = OPEN; this.onopen?.(); }
  protected fireMessage(data: string) { if (this.readyState === OPEN) this.onmessage?.({ data }); }
  protected fireClose(info: CloseInfo = {}) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onclose?.(info);
  }
}

/** WebSocket first; if it never opens, the same connection is retried over HTTP. */
class AutoSocket extends Base {
  private inner: DuplexSocket | null = null;
  private closedByUs = false;

  constructor(private channel: string, private qs: string) {
    super();
    this.tryWs();
  }

  private tryWs() {
    const ws = new WebSocket(wsUrl(this.channel, this.qs));
    this.inner = ws as unknown as DuplexSocket;
    let opened = false;
    const timer = window.setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, WS_OPEN_TIMEOUT_MS);
    ws.onopen = () => { opened = true; window.clearTimeout(timer); lastUsed = 'websocket'; this.fireOpen(); };
    ws.onmessage = (ev) => this.fireMessage(String(ev.data));
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      window.clearTimeout(timer);
      if (opened || this.closedByUs) { this.fireClose({ code: ev.code, reason: ev.reason }); return; }
      this.tryHttp();
    };
  }

  private tryHttp() {
    const http = new HttpSocket(this.channel, this.qs, !sseHeldBack);
    this.inner = http;
    http.onopen = () => { wsBlocked = true; this.fireOpen(); };
    http.onmessage = (ev) => this.fireMessage(ev.data);
    http.onclose = (ev) => this.fireClose(ev);
    if (this.closedByUs) http.close();
  }

  send(data: string) {
    if (this.readyState !== OPEN || !this.inner) throw new Error('not open');
    this.inner.send(data);
  }

  close() {
    if (this.closedByUs) return;
    this.closedByUs = true;
    if (this.readyState === CONNECTING || this.readyState === OPEN) this.readyState = CLOSING;
    try { this.inner?.close(); } catch {}
  }
}

type PollReply = { frames: Array<{ seq: number; data: string }>; closed: boolean };

class Gone extends Error {}

/** One channel over HTTP: open, then stream (SSE) or long-poll down, POST up. */
export class HttpSocket extends Base {
  private id: string | null = null;
  private lastSeq = 0;
  private ackedSeq = 0;
  private outbox: string[] = [];
  private sentIndex = 0;
  private sending = false;
  private failures = 0;
  private es: EventSource | null = null;
  private pollAbort: AbortController | null = null;
  private timers = new Set<number>();
  private ackTimer: number | null = null;
  private closedByUs = false;

  constructor(private channel: string, private qs: string, private useSse: boolean) {
    super();
    if (typeof EventSource !== 'function') this.useSse = false;
    void this.start();
  }

  private base(): string { return `/api/rt/conn/${encodeURIComponent(this.id!)}`; }

  private later(fn: () => void, ms: number) {
    const t = window.setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  private async start() {
    try {
      const r = await fetch(`/api/rt/${this.channel}/open${this.qs ? `?${this.qs}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(`open ${r.status}`);
      this.id = (await r.json()).id;
    } catch {
      this.finish();
      return;
    }
    if (this.closedByUs) { this.postClose(); this.finish(); return; }
    lastUsed = this.useSse ? 'sse' : 'poll';
    this.fireOpen();
    this.ackTimer = window.setInterval(() => { if (this.lastSeq > this.ackedSeq) void this.flush(); }, ACK_INTERVAL_MS);
    if (this.useSse) this.openStream(); else void this.pollLoop();
  }

  private deliver(seq: number, data: string) {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.fireMessage(data);
  }

  // ---- down: SSE ----

  private openStream() {
    if (this.readyState !== OPEN) return;
    const es = new EventSource(`${this.base()}/stream?after=${this.lastSeq}`);
    this.es = es;
    let ready = false;
    const toPolling = () => {
      awaitingReady.delete(toPolling);
      window.clearTimeout(readyTimer);
      if (ready || this.es !== es) return;
      this.useSse = false;
      lastUsed = 'poll';
      es.close();
      this.es = null;
      void this.pollLoop();
    };
    awaitingReady.add(toPolling);
    const readyTimer = window.setTimeout(() => {
      if (ready || this.es !== es) return;
      // The proxy is holding the stream back: poll from here on, on every connection.
      sseHeldBack = true;
      for (const fn of [...awaitingReady]) fn();
    }, SSE_READY_MS);
    es.addEventListener('ready', () => { ready = true; this.failures = 0; awaitingReady.delete(toPolling); window.clearTimeout(readyTimer); });
    es.onmessage = (ev) => this.deliver(Number(ev.lastEventId), ev.data);
    es.addEventListener('close', () => { awaitingReady.delete(toPolling); window.clearTimeout(readyTimer); es.close(); this.es = null; this.finish(); });
    es.onerror = () => {
      awaitingReady.delete(toPolling);
      window.clearTimeout(readyTimer);
      es.close();
      if (this.es !== es) return;
      this.es = null;
      // Stream dropped: pick up anything queued, then reconnect (or learn it's gone).
      void this.pollOnce(0).then(
        () => { this.failures = 0; this.openStream(); },
        (err) => {
          if (err instanceof Gone || ++this.failures >= MAX_HTTP_FAILURES) { this.finish(); return; }
          this.later(() => this.openStream(), 1000 * this.failures);
        },
      );
    };
  }

  // ---- down: long polling ----

  private async pollOnce(wait: number): Promise<void> {
    const ac = new AbortController();
    this.pollAbort = ac;
    const r = await fetch(`${this.base()}/poll?after=${this.lastSeq}&wait=${wait}`, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal });
    if (r.status === 404 || r.status === 401) throw new Gone();
    if (!r.ok) throw new Error(`poll ${r.status}`);
    const body = (await r.json()) as PollReply;
    if (this.readyState !== OPEN) return;
    for (const f of body.frames) this.deliver(f.seq, f.data);
    this.ackedSeq = this.lastSeq; // the poll's `after` confirms everything before it
    if (body.closed) this.finish();
  }

  private async pollLoop() {
    while (this.readyState === OPEN) {
      try {
        await this.pollOnce(POLL_WAIT_MS);
        this.failures = 0;
      } catch (err) {
        if (this.readyState !== OPEN) return;
        if (err instanceof Gone || ++this.failures >= MAX_HTTP_FAILURES) { this.finish(); return; }
        await new Promise((r) => this.later(() => r(null), 1000 * this.failures));
      }
    }
  }

  // ---- up ----

  send(data: string) {
    if (this.readyState === CONNECTING) throw new Error('not open');
    if (this.readyState !== OPEN) return;
    this.outbox.push(data);
    void this.flush();
  }

  private async flush() {
    if (this.sending || this.readyState !== OPEN || !this.id) return;
    this.sending = true;
    const frames = this.outbox.slice();
    const ack = this.lastSeq;
    try {
      const r = await fetch(`${this.base()}/send`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.sentIndex, frames, ack }),
      });
      if (r.status === 404 || r.status === 401) { this.sending = false; this.finish(); return; }
      if (!r.ok) throw new Error(`send ${r.status}`);
      this.outbox.splice(0, frames.length);
      this.sentIndex += frames.length;
      this.ackedSeq = Math.max(this.ackedSeq, ack);
      this.sending = false;
      if (this.outbox.length > 0) void this.flush();
    } catch {
      this.sending = false;
      // Same frames, same `from`: the server skips any it already applied.
      if (this.readyState === OPEN) this.later(() => void this.flush(), 1000);
    }
  }

  // ---- lifecycle ----

  private postClose() {
    if (!this.id) return;
    try { void fetch(`${this.base()}/close`, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {}); } catch {}
  }

  close() {
    if (this.closedByUs || this.readyState === CLOSED) return;
    this.closedByUs = true;
    if (this.readyState === CONNECTING) { this.readyState = CLOSING; return; } // start() finishes
    this.readyState = CLOSING;
    this.postClose();
    window.setTimeout(() => this.finish(), 0); // async, like WebSocket
  }

  private finish() {
    if (this.readyState === CLOSED) return;
    this.es?.close();
    this.es = null;
    this.pollAbort?.abort();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    if (this.ackTimer) { window.clearInterval(this.ackTimer); this.ackTimer = null; }
    this.fireClose();
  }
}
