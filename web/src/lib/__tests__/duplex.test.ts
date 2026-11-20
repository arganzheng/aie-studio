import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDuplexState, lastTransport, openDuplex } from '../duplex';

// A fake server: one HTTP channel whose poll replies come from `queue`.
type Call = { url: string; body?: any };
let calls: Call[];
let queue: Array<{ frames: Array<{ seq: number; data: string }>; closed: boolean }>;
let openStatus: number;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

class BlockedWebSocket {
  static instances = 0;
  onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null;
  readyState = 0;
  constructor(public url: string) {
    BlockedWebSocket.instances++;
    // A proxy answering 403: the socket closes without ever opening.
    setTimeout(() => { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006, reason: '' }); }, 0);
  }
  addEventListener() {}
  close() {}
  send() {}
}

beforeEach(() => {
  _resetDuplexState();
  calls = [];
  queue = [];
  openStatus = 200;
  BlockedWebSocket.instances = 0;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
  vi.stubGlobal('WebSocket', BlockedWebSocket);
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/open')) return openStatus === 200 ? json({ id: 'c1' }) : json({}, openStatus);
    if (url.includes('/poll')) {
      const next = queue.shift();
      if (next) return json(next);
      // Nothing queued: hang like a long poll until aborted.
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return json({ ok: true });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('openDuplex', () => {
  it('falls back to HTTP when the WebSocket is blocked, and remembers it', async () => {
    queue.push({ frames: [{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }], closed: false });
    const got: string[] = [];
    const s = openDuplex('session', 'project=p', 'auto');
    const opened = vi.fn();
    s.onopen = opened;
    s.onmessage = (ev) => got.push(ev.data);
    // SSE isn't available in node; force the poll path for this test.
    vi.stubGlobal('EventSource', undefined);
    await tick(); await tick();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('/api/rt/session/open?project=p');
    s.close();
    await tick();

    // Second connection skips the WebSocket entirely.
    openDuplex('events', '', 'auto');
    expect(BlockedWebSocket.instances).toBe(1);
  });

  it('long-polls frames in order and sends with a running index', async () => {
    queue.push({ frames: [{ seq: 1, data: 'a' }], closed: false });
    queue.push({ frames: [{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }], closed: false });
    const got: string[] = [];
    const s = openDuplex('session', '', 'poll');
    s.onmessage = (ev) => got.push(ev.data);
    await tick(); await tick();
    expect(got).toEqual(['a', 'b']); // the repeated seq 1 is dropped
    expect(lastTransport()).toBe('poll');
    expect(calls.filter((c) => c.url.includes('/poll')).map((c) => c.url)).toEqual([
      '/api/rt/conn/c1/poll?after=0&wait=25000',
      '/api/rt/conn/c1/poll?after=1&wait=25000',
      '/api/rt/conn/c1/poll?after=2&wait=25000',
    ]);
    s.send('x');
    await tick();
    s.send('y');
    await tick();
    const sends = calls.filter((c) => c.url.endsWith('/send')).map((c) => c.body);
    expect(sends).toEqual([{ from: 0, frames: ['x'], ack: 2 }, { from: 1, frames: ['y'], ack: 2 }]);
    s.close();
  });

  it('reports close when the server closes the channel', async () => {
    queue.push({ frames: [], closed: true });
    const s = openDuplex('session', '', 'poll');
    const closed = vi.fn();
    s.onclose = closed;
    await tick(); await tick();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.readyState).toBe(3);
  });

  it('closes without opening when the HTTP open is refused', async () => {
    openStatus = 401;
    const s = openDuplex('session', '', 'auto');
    const opened = vi.fn(), closed = vi.fn();
    s.onopen = opened; s.onclose = closed;
    await tick(); await tick();
    expect(opened).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
