// Model: server.WebPush, the page side — subscribe this device to the
// server's pushes, unsubscribe, send a test. Needs a secure origin (HTTPS or
// localhost), a service worker and the Push API; on iPhone / iPad the app
// must be added to the Home Screen first (iOS 16.4+).

export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-home-screen';

export function pushSupport(env: {
  secure: boolean; sw: boolean; push: boolean; notification: boolean; ios: boolean; standalone: boolean;
}): PushSupport {
  if (!env.secure) return 'insecure';
  if (env.ios && !env.standalone) return 'ios-home-screen';
  if (!env.sw || !env.push || !env.notification) return 'unsupported';
  return 'ok';
}

export function currentPushSupport(): PushSupport {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return pushSupport({
    secure: window.isSecureContext,
    sw: 'serviceWorker' in navigator,
    push: 'PushManager' in window,
    notification: 'Notification' in window,
    ios,
    standalone: !!standalone,
  });
}

// "iPhone · Safari", "Mac · Chrome" — how the device is listed in Settings.
export function deviceLabel(ua: string): string {
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : '';
  return browser ? `${device} · ${browser}` : device;
}

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) return reg;
  return navigator.serviceWorker.register('/sw.js');
}

async function post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// This device's subscription, if it has one.
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (currentPushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Asks for notification permission (if not yet granted) and subscribes.
export async function enablePush(): Promise<void> {
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : 'Notification permission was not given.');
  const { publicKey } = await (await fetch('/api/push/key')).json();
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
  await post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel(navigator.userAgent) });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function testPush(): Promise<{ sent: number; failed: number; removed: number }> {
  const sub = await currentSubscription();
  return post('/api/push/test', sub ? { endpoint: sub.endpoint } : {});
}

export type PushDevice = { endpoint: string; label: string; createdAt: number; lastOkAt: number | null };
export async function listPushDevices(): Promise<PushDevice[]> {
  const r = await fetch('/api/push/subscriptions');
  if (!r.ok) return [];
  return (await r.json()).devices ?? [];
}

// The alert a notification click carried into a fresh page (sw.js: /#alert=…).
export function alertFromHash(hash: string): unknown {
  const m = /^#alert=(.+)$/.exec(hash);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}
