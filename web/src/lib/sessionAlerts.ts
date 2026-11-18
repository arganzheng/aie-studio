// Model: web.SessionAlerts — "a session finished / needs you" pop-ups fed by
// server.SessionEvents, shown whichever project or tab the page is on. Pure
// helpers only; App owns the state and the side effects (sound, system
// notification, document title).

export type SessionEventKind = 'done' | 'awaiting';

// Mirrors server/src/notify.ts SessionEvent.
export type SessionEvent = {
  id: string;
  kind: SessionEventKind;
  tabType: 'session' | 'claude-sdk' | 'devin';
  projectId: string;
  sessionId: string | null;
  title: string | null;
  // One line: the start of the agent's last reply, or its question.
  summary?: string | null;
  at: number;
};

type SessionTabLike = { id: string; type: string; resumeId?: string; title?: string };

export const MAX_ALERTS = 20;

// One alert per session: a later event for the same session replaces the
// earlier one (a "finished" after a "needs input", or the next question).
export function alertKey(e: SessionEvent): string {
  return `${e.projectId}:${e.tabType === 'devin' ? 'devin' : 'claude'}:${e.sessionId ?? e.id}`;
}

export function upsertAlert(alerts: readonly SessionEvent[], e: SessionEvent): SessionEvent[] {
  const key = alertKey(e);
  return [...alerts.filter((a) => alertKey(a) !== key), e].slice(-MAX_ALERTS);
}

// Does `tab` show the event's session? The two Claude tab kinds drive the
// same sessions (rule-405); Devin sessions are their own namespace.
export function tabShowsSession(tab: SessionTabLike | null | undefined, e: SessionEvent): boolean {
  if (!tab || !e.sessionId || tab.resumeId !== e.sessionId) return false;
  return e.tabType === 'devin' ? tab.type === 'devin' : tab.type === 'session' || tab.type === 'claude-sdk';
}

export type ViewState = {
  // The page is on screen and has keyboard focus.
  attending: boolean;
  activeProjectId: string | null;
  activeTab: SessionTabLike | null;
};

// The user is looking at this very session right now: nothing to tell them.
export function isViewing(e: SessionEvent, v: ViewState): boolean {
  return v.attending && v.activeProjectId === e.projectId && tabShowsSession(v.activeTab, e);
}

// Alerts left once the user is looking at `v`'s tab.
export function dropSeen(alerts: readonly SessionEvent[], v: ViewState): readonly SessionEvent[] {
  const next = alerts.filter((a) => !isViewing(a, v));
  return next.length === alerts.length ? alerts : next;
}

export function alertHeadline(kind: SessionEventKind): string {
  return kind === 'awaiting' ? 'Needs your input' : 'Finished';
}

// The session's name on the card: the tab's title if the tab is still there,
// else what the server knew, else a generic name.
export function alertSessionTitle(e: SessionEvent, tabs: readonly SessionTabLike[]): string {
  const tab = tabs.find((t) => tabShowsSession(t, e));
  return tab?.title?.trim() || e.title?.trim() || (e.tabType === 'devin' ? 'Devin session' : 'Claude session');
}

// Browser tab title with the unread count in front, like "(2) demo — AI Studio".
export function titleWithUnread(base: string, unread: number): string {
  return unread > 0 ? `(${unread}) ${base}` : base;
}
