import { useEffect, useRef } from 'react';
import type { SessionEvent } from './lib/sessionAlerts';

// Model: web.SessionAlerts ← server.SessionEvents. One /ws/events socket per
// page, kept open across project and tab switches. Reconnects with backoff
// and asks for what it missed (?since=), so a page that was asleep still
// hears about a session that finished meanwhile.
// `onInbox`: another page changed the inbox's read state (web.Inbox).
export function useSessionEvents(enabled: boolean, onEvent: (e: SessionEvent) => void, onInbox?: () => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onInboxRef = useRef(onInbox);
  onInboxRef.current = onInbox;
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let retryTimer: number | null = null;
    let pingTimer: number | null = null;
    // Server clock of the newest thing we saw; null until the first hello, so
    // a fresh page load doesn't replay old events.
    let since: number | null = null;
    const seen = new Set<string>();

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws/events${since === null ? '' : `?since=${since}`}`);
      ws = sock;
      sock.onopen = () => {
        retry = 0;
        pingTimer = window.setInterval(() => { try { sock.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25000);
      };
      sock.onmessage = (m) => {
        let msg: any;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg?.type === 'hello' && typeof msg.now === 'number') {
          since = Math.max(since ?? 0, msg.now);
          // (Re)connected: anything may have changed while we were away.
          onInboxRef.current?.();
          return;
        }
        if (msg?.type === 'inbox') { onInboxRef.current?.(); return; }
        if (msg?.type !== 'session' || !msg.event?.id || seen.has(msg.event.id)) return;
        seen.add(msg.event.id);
        if (typeof msg.event.at === 'number') since = Math.max(since ?? 0, msg.event.at);
        onEventRef.current(msg.event as SessionEvent);
      };
      sock.onclose = () => {
        if (pingTimer) { window.clearInterval(pingTimer); pingTimer = null; }
        if (ws === sock) ws = null;
        if (closed) return;
        retryTimer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
      sock.onerror = () => { try { sock.close(); } catch {} };
    }

    // Back on screen: don't wait out the backoff.
    function onVisible() {
      if (document.visibilityState !== 'visible' || ws || closed) return;
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
      retry = 0;
      connect();
    }

    connect();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (retryTimer) window.clearTimeout(retryTimer);
      if (pingTimer) window.clearInterval(pingTimer);
      try { ws?.close(); } catch {}
    };
  }, [enabled]);
}
