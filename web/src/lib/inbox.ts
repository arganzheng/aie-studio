// Model: web.Inbox — the notification history (server.Inbox), behind the
// inbox button next to the sidebar view switch. Collapsed by default; opens as
// a column beside the sidebar. Pure helpers only; App owns the state.
import { isViewing, type SessionEvent, type ViewState } from './sessionAlerts';

// Mirrors server/src/inbox.ts InboxItem.
export type InboxItem = SessionEvent & { readAt: number | null };
export type InboxFilter = 'all' | 'unread';
export type InboxState = { items: InboxItem[]; unread: number; hasMore: boolean };

export const INBOX_PAGE = 50;
export const EMPTY_INBOX: InboxState = { items: [], unread: 0, hasMore: false };

// Unread items for the session the user is looking at right now.
export function viewedUnread(items: readonly InboxItem[], v: ViewState): InboxItem[] {
  return items.filter((i) => i.readAt === null && isViewing(i, v));
}

// Apply a local read mark before the server confirms, so the dot clears at once.
export function markLocallyRead(s: InboxState, ids: ReadonlySet<string> | 'all', now: number): InboxState {
  let changed = 0;
  const items = s.items.map((i) => {
    if (i.readAt !== null || (ids !== 'all' && !ids.has(i.id))) return i;
    changed++;
    return { ...i, readAt: now };
  });
  if (changed === 0) return s;
  return { ...s, items, unread: ids === 'all' ? 0 : Math.max(0, s.unread - changed) };
}

export function removeLocally(s: InboxState, id: string): InboxState {
  const gone = s.items.find((i) => i.id === id);
  if (!gone) return s;
  return { ...s, items: s.items.filter((i) => i.id !== id), unread: gone.readAt === null ? Math.max(0, s.unread - 1) : s.unread };
}

// Short age for the list's right edge, like "5m", "3h", "7d".
export function shortAge(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}
