import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { generateVAPIDKeys, sendNotification, type PushSubscription } from 'web-push';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import type { SessionEvent } from './notify.js';

// Model: server.WebPush — session alerts (a turn finished, a session needs
// you) delivered to the user's devices through the browsers' push services,
// so they arrive even when no aie-studio page is open: a locked phone, a
// closed laptop tab. Each device subscribes once (Settings → Features →
// Push notifications); every event goes to every subscribed device of that
// user. Subscriptions the push service reports gone (404 / 410) are dropped.
//
// Files under the config dir:
//   vapid.json                    this server's VAPID key pair (made on first use)
//   users/<uid>/push.json         the user's subscriptions

export type StoredSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  // What the device called itself when subscribing ("iPhone · Safari").
  label: string;
  createdAt: number;
  lastOkAt?: number;
};

export type PushPayload = {
  title: string;
  body: string;
  // Same as the page's alertKey(): a push and the page's own notification
  // for one session replace each other instead of stacking.
  tag: string;
  data: SessionEvent | { test: true };
};

function configDir(): string {
  return process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
}
function subsFile(uid: string): string {
  return path.join(configDir(), 'users', uid, 'push.json');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return fallback; }
}
async function writeJson(file: string, data: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode });
  await fs.rename(tmp, file);
}

// ---- VAPID ----------------------------------------------------------------

export type Vapid = { publicKey: string; privateKey: string; subject: string };
let vapidCache: Promise<Vapid> | null = null;

// The push services want a contact for the sender; a URL works for all of them.
const DEFAULT_SUBJECT = 'https://github.com/arganzheng/aie-studio';

export function vapid(): Promise<Vapid> {
  if (!vapidCache) {
    vapidCache = (async () => {
      const file = path.join(configDir(), 'vapid.json');
      const have = await readJson<Partial<Vapid> | null>(file, null);
      const subject = process.env.AIE_PUSH_SUBJECT || have?.subject || DEFAULT_SUBJECT;
      if (have?.publicKey && have.privateKey) return { publicKey: have.publicKey, privateKey: have.privateKey, subject };
      const keys = generateVAPIDKeys();
      const v = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
      await writeJson(file, v);
      return v;
    })();
    vapidCache.catch(() => { vapidCache = null; });
  }
  return vapidCache;
}

// ---- subscriptions ----------------------------------------------------------

// Pure: a subscription from the page, checked; null when unusable.
export function validSubscription(raw: unknown, label: unknown, now: number): StoredSubscription | null {
  const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 2048) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return null;
  return {
    endpoint: s.endpoint,
    keys: { p256dh, auth },
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : 'Device',
    createdAt: now,
  };
}

// Pure: add (or refresh) a subscription; one entry per endpoint.
export function upsertSubscription(list: readonly StoredSubscription[], sub: StoredSubscription): StoredSubscription[] {
  return [...list.filter((s) => s.endpoint !== sub.endpoint), sub];
}

export async function listSubscriptions(uid: string): Promise<StoredSubscription[]> {
  const v = await readJson<unknown>(subsFile(uid), []);
  return Array.isArray(v) ? (v as StoredSubscription[]) : [];
}
async function saveSubscriptions(uid: string, list: StoredSubscription[]): Promise<void> {
  await writeJson(subsFile(uid), list);
}

// One writer at a time per user: deliveries and (un)subscribes all rewrite push.json.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(uid) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(uid, next.catch(() => {}));
  return next;
}

// ---- payload ----------------------------------------------------------------

// Pure: what the notification says. `project` is the project's name.
export function payloadFor(e: SessionEvent, project: string | null): PushPayload {
  const who = e.title || (e.tabType === 'devin' ? 'Devin session' : 'Claude session');
  const what = e.kind === 'awaiting' ? 'Needs you' : 'Finished';
  const lines = [`${what}${project ? ` · ${project}` : ''}`];
  if (e.summary) lines.push(e.summary.length > 160 ? `${e.summary.slice(0, 159)}…` : e.summary);
  return {
    title: who,
    body: lines.join('\n'),
    tag: `${e.projectId}:${e.tabType === 'devin' ? 'devin' : 'claude'}:${e.sessionId ?? e.id}`,
    data: e,
  };
}

// ---- delivery ---------------------------------------------------------------

export type Sender = (sub: PushSubscription, body: string, opts: { vapidDetails: Vapid; TTL: number; urgency: 'high' | 'normal'; topic?: string }) => Promise<unknown>;
let sender: Sender = (sub, body, opts) => sendNotification(sub, body, opts);
// Tests swap the network out.
export function setSender(s: Sender | null): void {
  sender = s ?? ((sub, body, opts) => sendNotification(sub, body, opts));
}

// The push service no longer knows this subscription (unsubscribed,
// expired, app removed): stop sending to it.
function isGone(err: unknown): boolean {
  const code = (err as { statusCode?: number })?.statusCode;
  return code === 404 || code === 410;
}

export type DeliveryResult = { sent: number; failed: number; removed: number };

// `only`: just this device (Settings' "Send a test").
export async function deliver(uid: string, payload: PushPayload, urgent: boolean, only?: string): Promise<DeliveryResult> {
  const subs = (await listSubscriptions(uid)).filter((s) => !only || s.endpoint === only);
  if (subs.length === 0) return { sent: 0, failed: 0, removed: 0 };
  const v = await vapid();
  const body = JSON.stringify(payload);
  const gone = new Set<string>();
  const ok = new Set<string>();
  let failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      // A day is plenty: an alert older than that is old news.
      await sender({ endpoint: s.endpoint, keys: s.keys }, body, { vapidDetails: v, TTL: 24 * 3600, urgency: urgent ? 'high' : 'normal' });
      ok.add(s.endpoint);
    } catch (err) {
      if (isGone(err)) gone.add(s.endpoint);
      else { failed++; console.error(`[push] ${s.label}: ${String((err as Error)?.message ?? err).slice(0, 200)}`); }
    }
  }));
  if (gone.size || ok.size) {
    const now = Date.now();
    await withLock(uid, async () => {
      const cur = await listSubscriptions(uid);
      await saveSubscriptions(uid, cur.filter((s) => !gone.has(s.endpoint)).map((s) => (ok.has(s.endpoint) ? { ...s, lastOkAt: now } : s)));
    });
  }
  return { sent: ok.size, failed, removed: gone.size };
}

// Called by notify.ts for every session event. Never throws.
export function pushSessionEvent(uid: string, e: SessionEvent): void {
  void (async () => {
    try {
      const project = await getProject(uid, e.projectId).catch(() => null);
      await deliver(uid, payloadFor(e, project?.name ?? null), e.kind === 'awaiting');
    } catch (err) {
      console.error('[push] delivery failed:', err);
    }
  })();
}

// ---- routes -----------------------------------------------------------------

export function registerPushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', async (req, reply) => {
    if (!getUserId(req)) return reply.code(401).send({ error: 'unauthorized' });
    return { publicKey: (await vapid()).publicKey };
  });

  // The user's subscribed devices (for Settings).
  app.get('/api/push/subscriptions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const subs = await listSubscriptions(uid);
    return { devices: subs.map((s) => ({ endpoint: s.endpoint, label: s.label, createdAt: s.createdAt, lastOkAt: s.lastOkAt ?? null })) };
  });

  app.post<{ Body: { subscription?: unknown; label?: unknown } }>('/api/push/subscribe', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const sub = validSubscription(req.body?.subscription, req.body?.label, Date.now());
    if (!sub) return reply.code(400).send({ error: 'invalid subscription' });
    await withLock(uid, async () => saveSubscriptions(uid, upsertSubscription(await listSubscriptions(uid), sub)));
    return { ok: true };
  });

  app.post<{ Body: { endpoint?: unknown } }>('/api/push/unsubscribe', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== 'string') return reply.code(400).send({ error: 'endpoint required' });
    await withLock(uid, async () => saveSubscriptions(uid, (await listSubscriptions(uid)).filter((s) => s.endpoint !== endpoint)));
    return { ok: true };
  });

  // "Send a test" in Settings: to every device, or just the one asking.
  app.post<{ Body: { endpoint?: unknown } }>('/api/push/test', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const payload: PushPayload = { title: 'aie-studio', body: 'Test notification: push works on this device.', tag: 'aie-push-test', data: { test: true } };
    const only = typeof req.body?.endpoint === 'string' ? req.body.endpoint : null;
    if (only) {
      const subs = (await listSubscriptions(uid)).filter((s) => s.endpoint === only);
      if (subs.length === 0) return reply.code(404).send({ error: 'this device is not subscribed' });
    }
    return deliver(uid, payload, true, only ?? undefined);
  });
}
