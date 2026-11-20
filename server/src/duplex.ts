// HTTP fallback for the /ws/* channels, for networks whose proxy refuses the
// WebSocket upgrade (e.g. corporate proxies answering `403 WebSocketBlock`).
//
// A channel is registered once with `duplexRoute`; it is then reachable both as
// a real WebSocket (`/ws/<name>`) and over plain HTTP:
//
//   GET  /api/rt/<name>/open?<same query as the ws url>  → { id }
//   GET  /api/rt/conn/<id>/stream?after=<seq>             → text/event-stream
//   GET  /api/rt/conn/<id>/poll?after=<seq>&wait=<ms>     → { frames, closed }
//   POST /api/rt/conn/<id>/send   { from, frames, ack }   → { ok }
//   POST /api/rt/conn/<id>/close                          → { ok }
//
// The handler receives a `VirtualSocket` that implements the small part of the
// `ws` API the channel handlers use (send / close / terminate / ping and the
// message / close / pong events), so the handlers don't know which transport a
// client is on. Server→client frames carry a sequence number and stay buffered
// until the client acknowledges them (`after=`), so a dropped SSE stream or poll
// loses nothing. Client→server frames carry an index (`from`) so a retried POST
// isn't applied twice. All /api/* routes already go through the auth hook.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { getUserId } from './auth.js';

type Handler = (socket: WebSocket, req: FastifyRequest<any>) => unknown;

/** A connection with no stream open and no request for this long is dropped. */
export const IDLE_CLOSE_MS = 60_000;
/** Longest a poll request is held open when nothing is queued. */
export const POLL_WAIT_MAX_MS = 25_000;
/** Comment line sent on an idle SSE stream so proxies don't time it out. */
const SSE_KEEPALIVE_MS = 15_000;
/** Unacknowledged frames kept per connection before it is given up on. */
export const MAX_BUFFERED_FRAMES = 20_000;

type Frame = { seq: number; data: string };

export class VirtualSocket extends EventEmitter {
  readonly id = randomUUID();
  readonly uid: string;
  /** Next sequence number to assign; frames are numbered from 1. */
  private nextSeq = 1;
  private buffer: Frame[] = [];
  /** Index of the next client frame we expect (dedupes retried POSTs). */
  private recvIndex = 0;
  closed = false;
  /** Time of the last request from the client, or of an open stream. */
  lastSeen = Date.now();
  /** Open SSE streams / waiting polls; woken when a frame arrives or on close. */
  private waiters = new Set<() => void>();
  streams = 0;

  constructor(uid: string) {
    super();
    this.uid = uid;
  }

  // ---- the ws API the channel handlers use ----

  send(data: string | Buffer): void {
    if (this.closed) return;
    this.buffer.push({ seq: this.nextSeq++, data: typeof data === 'string' ? data : data.toString() });
    if (this.buffer.length > MAX_BUFFERED_FRAMES) { this.close(); return; }
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    // Async like ws: handlers may call close() before registering 'close'.
    setImmediate(() => this.emit('close'));
  }

  terminate(): void { this.close(); }

  /** No transport-level ping over HTTP: alive means the client was heard from recently. */
  ping(): void {
    if (this.isAlive(Date.now())) setImmediate(() => this.emit('pong'));
  }

  // ---- transport side ----

  isAlive(now: number): boolean {
    return !this.closed && (this.streams > 0 || now - this.lastSeen < IDLE_CLOSE_MS);
  }

  touch(): void { this.lastSeen = Date.now(); }

  /** Drop frames the client confirmed and return the rest. */
  framesAfter(after: number): Frame[] {
    if (after > 0) {
      let i = 0;
      while (i < this.buffer.length && this.buffer[i].seq <= after) i++;
      if (i > 0) this.buffer.splice(0, i);
    }
    return this.buffer.slice();
  }

  /** Apply client frames starting at index `from`; already-seen ones are skipped. */
  receive(from: number, frames: string[]): void {
    for (let i = 0; i < frames.length; i++) {
      const index = from + i;
      if (index < this.recvIndex) continue;
      if (index > this.recvIndex) break; // gap: client will resend
      this.recvIndex++;
      if (!this.closed) this.emit('message', Buffer.from(frames[i]));
    }
  }

  get received(): number { return this.recvIndex; }

  onWake(fn: () => void): () => void {
    this.waiters.add(fn);
    return () => { this.waiters.delete(fn); };
  }

  private wake(): void {
    for (const fn of [...this.waiters]) fn();
  }
}

const channels = new Map<string, Handler>();
const conns = new Map<string, VirtualSocket>();

/** Register a channel as `/ws/<name>` and as an HTTP channel under /api/rt/<name>. */
export function duplexRoute<Q = Record<string, string | undefined>>(
  app: FastifyInstance,
  path: string,
  handler: (socket: WebSocket, req: FastifyRequest<{ Querystring: Q }>) => unknown,
): void {
  if (!path.startsWith('/ws/')) throw new Error(`duplexRoute: ${path} is not under /ws/`);
  app.get<{ Querystring: Q }>(path, { websocket: true }, handler as any);
  channels.set(path.slice('/ws/'.length), handler as Handler);
}

function connFor(req: FastifyRequest<{ Params: { id: string } }>): VirtualSocket | null {
  const conn = conns.get(req.params.id);
  if (!conn || conn.uid !== getUserId(req)) return null;
  conn.touch();
  return conn;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let reaper: NodeJS.Timeout | null = null;

export function registerDuplexRoutes(app: FastifyInstance): void {
  app.get<{ Params: { channel: string } }>('/api/rt/:channel/open', async (req, reply) => {
    const handler = channels.get(req.params.channel);
    if (!handler) return reply.code(404).send({ error: 'unknown channel' });
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const conn = new VirtualSocket(uid);
    conns.set(conn.id, conn);
    conn.once('close', () => { setTimeout(() => conns.delete(conn.id), IDLE_CLOSE_MS); });
    // The handler sees this request: same cookies, same query as /ws/<name>.
    void Promise.resolve()
      .then(() => handler(conn as unknown as WebSocket, req))
      .catch((err) => { req.log.error({ err }, 'duplex handler failed'); conn.close(); });
    return { id: conn.id };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/rt/conn/:id/stream', (req, reply) => {
    const conn = connFor(req);
    if (!conn) { reply.code(404).send({ error: 'no such connection' }); return; }
    reply.hijack(); // bypass compression and the reply lifecycle; we own the socket
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    // Padding pushes the first event past small proxy buffers; `ready` lets the
    // client tell a working stream from one a proxy holds back.
    res.write(`:${' '.repeat(2048)}\n\nevent: ready\ndata: {}\n\n`);
    let sent = num(req.query.after, 0);
    conn.streams++;
    const flush = () => {
      for (const f of conn.framesAfter(0)) {
        if (f.seq <= sent) continue;
        // JSON frames have no raw newlines; split defensively anyway.
        res.write(`id: ${f.seq}\n${f.data.split('\n').map((l) => `data: ${l}`).join('\n')}\n\n`);
        sent = f.seq;
      }
      if (conn.closed) { res.write('event: close\ndata: {}\n\n'); end(); }
    };
    const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, SSE_KEEPALIVE_MS);
    let ended = false;
    const off = conn.onWake(flush);
    function end() {
      if (ended) return;
      ended = true;
      off();
      clearInterval(keepalive);
      conn!.streams--;
      conn!.touch();
      try { res.end(); } catch {}
    }
    req.raw.on('close', end);
    conn.framesAfter(sent); // the client confirmed everything up to `after`
    flush();
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; wait?: string } }>('/api/rt/conn/:id/poll', async (req, reply) => {
    const conn = connFor(req);
    if (!conn) return reply.code(404).send({ error: 'no such connection' });
    const after = num(req.query.after, 0);
    const wait = Math.min(num(req.query.wait, POLL_WAIT_MAX_MS), POLL_WAIT_MAX_MS);
    let frames = conn.framesAfter(after);
    if (frames.length === 0 && !conn.closed && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait);
        const off = conn.onWake(done);
        req.raw.on('close', done);
        function done() { clearTimeout(timer); off(); resolve(); }
      });
      conn.touch();
      frames = conn.framesAfter(after);
    }
    reply.header('Cache-Control', 'no-store');
    return { frames, closed: conn.closed && frames.length === 0 };
  });

  app.post<{ Params: { id: string }; Body: { from?: number; frames?: unknown; ack?: number } }>('/api/rt/conn/:id/send', async (req, reply) => {
    const conn = connFor(req);
    if (!conn) return reply.code(404).send({ error: 'no such connection' });
    // SSE clients confirm what they got here (the stream itself is one-way).
    conn.framesAfter(num(req.body?.ack, 0));
    const frames = Array.isArray(req.body?.frames) ? req.body.frames.filter((f): f is string => typeof f === 'string') : [];
    conn.receive(num(req.body?.from, 0), frames);
    return { ok: true, received: conn.received, closed: conn.closed };
  });

  app.post<{ Params: { id: string } }>('/api/rt/conn/:id/close', async (req) => {
    connFor(req)?.close();
    return { ok: true };
  });

  if (!reaper) {
    reaper = setInterval(() => {
      const now = Date.now();
      for (const conn of conns.values()) if (!conn.closed && !conn.isAlive(now)) conn.close();
    }, 10_000);
    reaper.unref();
  }
}

/** Test hook: the live connection registry. */
export function _connsForTest(): Map<string, VirtualSocket> { return conns; }
