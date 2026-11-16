import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { getUserId } from './auth.js';

// Model: server.SessionEvents — tells a user's open pages that one of their
// AI sessions finished a turn or is waiting on them, whichever project / tab
// the page is showing (web.SessionAlerts). The session bridges publish; each
// page holds one /ws/events socket. A session panel's own socket can't do
// this: it only exists while that tab is mounted.

export type SessionEventKind =
  // A turn ended and nothing is waiting on the user.
  | 'done'
  // The agent is blocked on the user (ask_user_question form, permission prompt).
  | 'awaiting';

// Which tab kind drives the session: the cli bridge, the SDK bridge or Devin.
export type SessionTabType = 'session' | 'claude-sdk' | 'devin';

// Who a live session belongs to; stamped on the bridge entry when it is created.
export type SessionOwner = { uid: string; projectId: string; tabType: SessionTabType };

export type SessionEvent = {
  id: string;
  kind: SessionEventKind;
  tabType: SessionTabType;
  projectId: string;
  // Null only for a brand-new session that hasn't reported its id yet.
  sessionId: string | null;
  title: string | null;
  at: number;
};

// A page that was asleep (phone locked, laptop lid closed) reconnects with
// ?since=<time of the last event it saw> and gets what it missed, within
// these bounds.
export const BACKLOG_MAX = 30;
export const BACKLOG_TTL_MS = 30 * 60 * 1000;

// Pure half of the backlog: append `event`, drop what is too old or too many.
export function pushBacklog(backlog: readonly SessionEvent[], event: SessionEvent, now: number): SessionEvent[] {
  return [...backlog, event].filter((e) => now - e.at <= BACKLOG_TTL_MS).slice(-BACKLOG_MAX);
}

// Events a reconnecting page hasn't seen. No `since` = a fresh page load: it
// starts clean rather than replaying old news.
export function eventsSince(backlog: readonly SessionEvent[], since: number | null, now: number): SessionEvent[] {
  if (since === null || !Number.isFinite(since)) return [];
  return backlog.filter((e) => e.at > since && now - e.at <= BACKLOG_TTL_MS);
}

const subscribers = new Map<string, Set<WebSocket>>();
const backlogs = new Map<string, SessionEvent[]>();

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

export function publishSessionEvent(
  owner: SessionOwner,
  kind: SessionEventKind,
  sessionId: string | null,
  title: string | null,
): void {
  const now = Date.now();
  const event: SessionEvent = {
    id: randomUUID(),
    kind,
    tabType: owner.tabType,
    projectId: owner.projectId,
    sessionId,
    title,
    at: now,
  };
  backlogs.set(owner.uid, pushBacklog(backlogs.get(owner.uid) ?? [], event, now));
  for (const socket of subscribers.get(owner.uid) ?? []) send(socket, { type: 'session', event });
}

export function registerNotifyRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { since?: string } }>('/ws/events', { websocket: true }, (socket, req) => {
    const uid = getUserId(req as any);
    if (!uid) {
      send(socket, { type: 'error', message: 'unauthorized' });
      try { socket.close(); } catch {}
      return;
    }
    let set = subscribers.get(uid);
    if (!set) subscribers.set(uid, (set = new Set()));
    set.add(socket);
    const since = req.query.since ? Number(req.query.since) : null;
    send(socket, { type: 'hello', now: Date.now() });
    for (const event of eventsSince(backlogs.get(uid) ?? [], since, Date.now())) send(socket, { type: 'session', event });
    socket.on('message', (raw: unknown) => {
      // Keep-alive only; the page never tells us anything else.
      try { if (JSON.parse(String(raw))?.type === 'ping') send(socket, { type: 'pong' }); } catch {}
    });
    socket.on('close', () => {
      set!.delete(socket);
      if (set!.size === 0) subscribers.delete(uid);
    });
  });
}
