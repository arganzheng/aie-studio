import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';

vi.mock('../auth.js', () => ({
  getUserId: (req: any) => (req.headers['x-test-user'] as string | undefined) ?? null,
}));

const { VirtualSocket, duplexRoute, registerDuplexRoutes, _connsForTest } = await import('../duplex.js');

describe('VirtualSocket', () => {
  it('numbers frames and drops the ones the client acknowledged', () => {
    const s = new VirtualSocket('u');
    s.send('a'); s.send('b'); s.send('c');
    expect(s.framesAfter(0).map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(s.framesAfter(2).map((f) => f.data)).toEqual(['c']);
    expect(s.framesAfter(0).map((f) => f.data)).toEqual(['c']);
  });

  it('applies client frames once and in order', () => {
    const s = new VirtualSocket('u');
    const got: string[] = [];
    s.on('message', (b: Buffer) => got.push(b.toString()));
    s.receive(0, ['a', 'b']);
    s.receive(1, ['b', 'c']); // retried POST overlapping the first
    s.receive(5, ['x']); // gap: ignored until the missing ones arrive
    expect(got).toEqual(['a', 'b', 'c']);
    expect(s.received).toBe(3);
  });

  it('emits close once, asynchronously, and stops accepting frames', async () => {
    const s = new VirtualSocket('u');
    const onClose = vi.fn();
    s.close();
    s.on('close', onClose);
    s.close();
    s.send('late');
    await new Promise((r) => setImmediate(r));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(s.framesAfter(0)).toEqual([]);
  });

  it('answers ping with pong only while the client is around', async () => {
    const s = new VirtualSocket('u');
    const pong = vi.fn();
    s.on('pong', pong);
    s.ping();
    await new Promise((r) => setImmediate(r));
    expect(pong).toHaveBeenCalledTimes(1);
    s.lastSeen = 0;
    s.ping();
    await new Promise((r) => setImmediate(r));
    expect(pong).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP routes', () => {
  let app: ReturnType<typeof Fastify> | null = null;
  afterEach(async () => { await app?.close(); app = null; _connsForTest().clear(); });

  async function makeApp() {
    app = Fastify();
    await app.register(websocket);
    // Echo channel: greets with the query, echoes messages, closes on "bye".
    duplexRoute<{ name?: string }>(app, '/ws/echo', (socket, req) => {
      socket.send(JSON.stringify({ hello: req.query.name }));
      socket.on('message', (raw: Buffer) => {
        if (raw.toString() === 'bye') { socket.close(); return; }
        socket.send(raw.toString());
      });
    });
    registerDuplexRoutes(app);
    await app.ready();
    return app;
  }
  const as = (user: string) => ({ 'x-test-user': user });

  it('opens a channel with its query and round-trips frames over poll + send', async () => {
    const a = await makeApp();
    const open = await a.inject({ url: '/api/rt/echo/open?name=bob', headers: as('u1') });
    expect(open.statusCode).toBe(200);
    const { id } = open.json();

    const p1 = await a.inject({ url: `/api/rt/conn/${id}/poll?after=0&wait=0`, headers: as('u1') });
    expect(p1.json().frames).toEqual([{ seq: 1, data: '{"hello":"bob"}' }]);

    await a.inject({ method: 'POST', url: `/api/rt/conn/${id}/send`, headers: as('u1'), payload: { from: 0, frames: ['x', 'y'], ack: 1 } });
    const p2 = await a.inject({ url: `/api/rt/conn/${id}/poll?after=1&wait=0`, headers: as('u1') });
    expect(p2.json().frames.map((f: any) => f.data)).toEqual(['x', 'y']);

    await a.inject({ method: 'POST', url: `/api/rt/conn/${id}/send`, headers: as('u1'), payload: { from: 2, frames: ['bye'] } });
    const p3 = await a.inject({ url: `/api/rt/conn/${id}/poll?after=3&wait=0`, headers: as('u1') });
    expect(p3.json()).toEqual({ frames: [], closed: true });
  });

  it('holds a poll until a frame arrives', async () => {
    const a = await makeApp();
    const { id } = (await a.inject({ url: '/api/rt/echo/open', headers: as('u1') })).json();
    await new Promise((r) => setImmediate(r));
    const pending = a.inject({ url: `/api/rt/conn/${id}/poll?after=1&wait=5000`, headers: as('u1') });
    setTimeout(() => { void a.inject({ method: 'POST', url: `/api/rt/conn/${id}/send`, headers: as('u1'), payload: { from: 0, frames: ['late'] } }); }, 50);
    expect((await pending).json().frames.map((f: any) => f.data)).toEqual(['late']);
  });

  it("refuses other users' connections and unknown channels", async () => {
    const a = await makeApp();
    const { id } = (await a.inject({ url: '/api/rt/echo/open', headers: as('u1') })).json();
    expect((await a.inject({ url: `/api/rt/conn/${id}/poll?wait=0`, headers: as('u2') })).statusCode).toBe(404);
    expect((await a.inject({ url: '/api/rt/nope/open', headers: as('u1') })).statusCode).toBe(404);
    expect((await a.inject({ url: '/api/rt/echo/open' })).statusCode).toBe(401);
  });
});
