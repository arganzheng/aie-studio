import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateRequestDetails } from 'web-push';
import { deliver, listSubscriptions, payloadFor, setSender, upsertSubscription, validSubscription, vapid } from '../push.js';
import type { SessionEvent } from '../notify.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-push-'));
const prevDir = process.env.REMOTE_IDE_CONFIG_DIR;
beforeAll(() => { process.env.REMOTE_IDE_CONFIG_DIR = dir; });
afterAll(() => {
  if (prevDir === undefined) delete process.env.REMOTE_IDE_CONFIG_DIR; else process.env.REMOTE_IDE_CONFIG_DIR = prevDir;
  setSender(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A real browser-like subscription key pair, so web-push can encrypt to it.
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

const event: SessionEvent = {
  id: 'e1', kind: 'awaiting', tabType: 'claude-sdk', projectId: 'p1', sessionId: 's1',
  title: 'Fix the login bug', summary: 'Which branch should I push to?', at: 1,
};

describe('validSubscription', () => {
  it('keeps an https endpoint with both keys', () => {
    const keys = browserKeys();
    expect(validSubscription({ endpoint: 'https://push.example/abc', keys }, ' iPhone ', 5))
      .toEqual({ endpoint: 'https://push.example/abc', keys, label: 'iPhone', createdAt: 5 });
  });
  it('rejects the rest', () => {
    const keys = browserKeys();
    expect(validSubscription(null, '', 0)).toBeNull();
    expect(validSubscription({ endpoint: 'http://push.example/abc', keys }, '', 0)).toBeNull();
    expect(validSubscription({ endpoint: 'https://push.example/abc', keys: { p256dh: keys.p256dh } }, '', 0)).toBeNull();
  });
  it('keeps one entry per endpoint', () => {
    const a = validSubscription({ endpoint: 'https://p/1', keys: browserKeys() }, 'a', 1)!;
    const b = validSubscription({ endpoint: 'https://p/1', keys: browserKeys() }, 'b', 2)!;
    expect(upsertSubscription([a], b)).toEqual([b]);
  });
});

describe('payloadFor', () => {
  it('names the session, what happened and the project, tagged like the page', () => {
    expect(payloadFor(event, 'aie-studio')).toEqual({
      title: 'Fix the login bug',
      body: 'Needs you · aie-studio\nWhich branch should I push to?',
      tag: 'p1:claude:s1',
      data: event,
    });
    expect(payloadFor({ ...event, kind: 'done', title: null, summary: null, tabType: 'devin' }, null))
      .toMatchObject({ title: 'Devin session', body: 'Finished', tag: 'p1:devin:s1' });
  });
});

describe('deliver', () => {
  it('sends to every device, drops the ones the push service says are gone', async () => {
    const uid = 'u1';
    const subsFile = path.join(dir, 'users', uid, 'push.json');
    const live = validSubscription({ endpoint: 'https://push.example/live', keys: browserKeys() }, 'Mac', 1)!;
    const dead = validSubscription({ endpoint: 'https://push.example/dead', keys: browserKeys() }, 'Old phone', 1)!;
    fs.mkdirSync(path.dirname(subsFile), { recursive: true });
    fs.writeFileSync(subsFile, JSON.stringify([live, dead]));
    const seen: { endpoint: string; body: string; urgency: string }[] = [];
    setSender(async (sub, body, opts) => {
      seen.push({ endpoint: sub.endpoint, body, urgency: opts.urgency });
      if (sub.endpoint.endsWith('/dead')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    });
    const r = await deliver(uid, payloadFor(event, 'aie-studio'), true);
    expect(r).toEqual({ sent: 1, failed: 0, removed: 1 });
    expect(seen.map((s) => s.endpoint).sort()).toEqual(['https://push.example/dead', 'https://push.example/live']);
    expect(JSON.parse(seen[0].body).tag).toBe('p1:claude:s1');
    expect(seen[0].urgency).toBe('high');
    const left = await listSubscriptions(uid);
    expect(left.map((s) => s.endpoint)).toEqual(['https://push.example/live']);
    expect(left[0].lastOkAt).toBeGreaterThan(0);
  });

  it('keeps a device after a temporary failure', async () => {
    const uid = 'u2';
    const subsFile = path.join(dir, 'users', uid, 'push.json');
    const s = validSubscription({ endpoint: 'https://push.example/flaky', keys: browserKeys() }, 'Phone', 1)!;
    fs.mkdirSync(path.dirname(subsFile), { recursive: true });
    fs.writeFileSync(subsFile, JSON.stringify([s]));
    setSender(async () => { throw Object.assign(new Error('Service Unavailable'), { statusCode: 503 }); });
    expect(await deliver(uid, payloadFor(event, null), false)).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(await listSubscriptions(uid)).toHaveLength(1);
  });
});

describe('vapid + web-push request', () => {
  it('makes a key pair once and signs an encrypted request with it', async () => {
    const v1 = await vapid();
    const v2 = await vapid();
    expect(v2).toEqual(v1);
    expect(fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600);
    const req = generateRequestDetails({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: browserKeys() }, JSON.stringify(payloadFor(event, 'p')), { vapidDetails: v1, TTL: 60, urgency: 'high' });
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(req.headers.Authorization)).toMatch(new RegExp(`^vapid t=.+, k=${v1.publicKey}$`));
    expect(req.headers.TTL).toBe(60);
    expect(req.headers.Urgency).toBe('high');
    expect(Buffer.isBuffer(req.body)).toBe(true);
  });
});
