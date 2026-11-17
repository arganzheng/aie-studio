// Model: web.SessionList — the sidebar's list of every AI session (Claude and
// Devin), fed by server.ListAllSessions. Pure helpers only: filtering, the
// status line, relative times.

export type SessionKind = 'claude' | 'devin';
export type LiveState = 'running' | 'awaiting' | 'idle';

// Mirrors server/src/sessions-index.ts SessionRow.
export type SessionRow = {
  kind: SessionKind;
  sessionId: string;
  projectId: string;
  title: string;
  updatedAt: number;
  live: 'cli' | 'sdk' | 'devin' | null;
  state: LiveState | null;
  archived: boolean;
};

// Same shape as lib/sessionAlerts.alertKey, so a pending alert marks its row.
export function sessionRowKey(r: Pick<SessionRow, 'projectId' | 'kind' | 'sessionId'>): string {
  return `${r.projectId}:${r.kind}:${r.sessionId}`;
}

export type SessionFilter = {
  query: string;
  kind: 'all' | SessionKind;
  // 'active' = running, waiting on the user, or holding an unread alert.
  status: 'all' | 'active';
  // Show the archived sessions instead of the current ones.
  archived: boolean;
};

export const NO_FILTER: SessionFilter = { query: '', kind: 'all', status: 'all', archived: false };

export function isFiltering(f: SessionFilter): boolean {
  return f.kind !== 'all' || f.status !== 'all' || f.archived;
}

export function filterSessions(
  rows: readonly SessionRow[],
  f: SessionFilter,
  unread: ReadonlySet<string>,
): SessionRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (r.archived !== f.archived) return false;
    if (f.kind !== 'all' && r.kind !== f.kind) return false;
    if (f.status === 'active' && r.state !== 'running' && r.state !== 'awaiting' && !unread.has(sessionRowKey(r))) return false;
    if (q && !r.title.toLowerCase().includes(q) && !r.sessionId.toLowerCase().startsWith(q)) return false;
    return true;
  });
}

export type SessionTone = 'awaiting' | 'running' | 'unread' | 'idle';

// What the row's second line says. A question outranks a spinner, which
// outranks "there is a result you haven't looked at".
export function sessionStatus(r: SessionRow, unread: boolean, now: number): { tone: SessionTone; label: string } {
  if (r.state === 'awaiting') return { tone: 'awaiting', label: 'Needs your input' };
  if (r.state === 'running') return { tone: 'running', label: 'Running…' };
  if (unread) return { tone: 'unread', label: `Finished · ${timeAgo(r.updatedAt, now)}` };
  return { tone: 'idle', label: timeAgo(r.updatedAt, now) };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function timeAgo(ts: number, now: number): string {
  if (!ts) return '';
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) { const h = Math.floor(d / HOUR); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  if (d < 2 * DAY) return 'yesterday';
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} days ago`;
  if (d < 60 * DAY) return 'last month';
  if (d < 365 * DAY) return `${Math.floor(d / (30 * DAY))} months ago`;
  return new Date(ts).toLocaleDateString();
}
