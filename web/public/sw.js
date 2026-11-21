// Minimal service worker — installable PWA, no caching.
// Chrome's installability check requires a registered SW with a fetch
// handler; the handler doesn't need to do anything beyond exist. We deliberately
// don't cache: every asset (HTML/JS/CSS) and every API/WS call is server-backed,
// and stale cached HTML pointing at an old JS bundle would break worse than a
// network error would.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentional pass-through.
});

// Session alerts (web.SessionAlerts): the page shows its system notifications
// through this worker. A click brings the app's window forward and hands the
// alert back to the page, which opens the session.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      await win.focus().catch(() => {});
      win.postMessage({ type: 'session-alert-open', event: data });
    } else {
      // No window to hand it to (the app was closed): open one and pass the
      // alert in the URL; the page picks it up once it has loaded.
      const url = data && data.projectId ? `/#alert=${encodeURIComponent(JSON.stringify(data))}` : '/';
      await self.clients.openWindow(url);
    }
  })());
});

// Model: server.WebPush — an alert pushed by the server while no page may be
// open. Every push must show a notification (browsers revoke the
// subscription otherwise). The tag matches the page's own notification for
// the same session, so the two replace each other instead of stacking.
self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; }
  catch { p = { title: 'aie-studio', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(p.title || 'aie-studio', {
    body: p.body || '',
    tag: p.tag || undefined,
    renotify: !!p.tag,
    data: p.data || null,
    icon: '/icon.svg',
  }));
});
