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
  // Claude: the subagents it has spawned (absent for Devin).
  subagents?: { total: number; running: number };
  // The session this one was opened under as a child, if any.
  parentId?: string;
  // Claude: the git worktree it runs in (a name under .claude/worktrees).
  worktree?: string;
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

// ---- Sections: the project's tab Groups folded into the list -------------
//
// In the "This project" scope the list is split by tab Group (model: web.
// SessionList rule "groups"): each Group heads a section holding the session
// tabs it has open, in tab order; sessions with no open tab fall to a final
// History section. Non-session tabs (files, editors, observe) only count.

export const DEFAULT_SECTION_ID = 'default';

// The slice of a Tab this needs (web/src/types.ts Tab).
export type SectionTab = { id: string; type: string; resumeId?: string; title?: string; groupId?: string; parentSessionId?: string };
export type SectionGroup = { id: string; name: string };

export type SectionItem = {
  tabId: string;
  kind: SessionKind;
  // null: the tab has no listed session yet (a fresh tab before its first
  // reply, or the list hasn't caught up) — shown with the tab's own title.
  row: SessionRow | null;
  title: string;
};
export type SessionSection = {
  groupId: string;
  name: string;
  isDefault: boolean;
  items: SectionItem[];
  // Every tab in the Group, and how many of them are not sessions.
  tabCount: number;
  otherTabs: number;
};

function tabKind(t: SectionTab): SessionKind | null {
  if (t.type === 'devin') return 'devin';
  if (t.type === 'session' || t.type === 'claude-sdk') return 'claude';
  return null;
}

export function sectionSessions(input: {
  projectId: string;
  // After filterSessions — what may be shown.
  rows: readonly SessionRow[];
  // Before filtering — to tell "filtered out" from "not listed yet".
  allRows: readonly SessionRow[];
  tabs: readonly SectionTab[];
  groups: readonly SectionGroup[];
  defaultName: string;
  // A search or filter is on: tabs without a listed session are hidden, and
  // so are sections left with nothing to show.
  filtering: boolean;
}): { sections: SessionSection[]; history: SessionRow[] } {
  const { projectId, rows, allRows, tabs, groups, defaultName, filtering } = input;
  const shown = new Map(rows.map((r) => [sessionRowKey(r), r]));
  const listed = new Set(allRows.map(sessionRowKey));
  const opened = new Set<string>();

  const byGroup = new Map<string, SessionSection>();
  const section = (gid: string): SessionSection => {
    let s = byGroup.get(gid);
    if (!s) {
      const g = groups.find((x) => x.id === gid);
      s = { groupId: gid, name: g?.name ?? defaultName, isDefault: !g, items: [], tabCount: 0, otherTabs: 0 };
      byGroup.set(gid, s);
    }
    return s;
  };
  for (const g of groups) section(g.id);

  for (const t of tabs) {
    // A tab whose Group is gone belongs to the default one (types.tabGroupId).
    const gid = t.groupId && groups.some((g) => g.id === t.groupId) ? t.groupId : DEFAULT_SECTION_ID;
    const s = section(gid);
    s.tabCount++;
    const kind = tabKind(t);
    if (!kind) { s.otherTabs++; continue; }
    const key = t.resumeId ? sessionRowKey({ projectId, kind, sessionId: t.resumeId }) : null;
    const row = key ? shown.get(key) ?? null : null;
    if (key) opened.add(key);
    if (row) { s.items.push({ tabId: t.id, kind, row, title: row.title }); continue; }
    if (key && listed.has(key)) continue; // listed, but the filter hides it
    if (filtering) continue;
    s.items.push({ tabId: t.id, kind, row: null, title: t.title || (kind === 'devin' ? 'New Devin session' : 'New session') });
  }

  // User Groups in their order; the default Group last, and only while it
  // holds tabs (same rule as the old Groups view).
  const sections = [
    ...groups.map((g) => byGroup.get(g.id)!),
    ...(byGroup.get(DEFAULT_SECTION_ID)?.tabCount ? [byGroup.get(DEFAULT_SECTION_ID)!] : []),
  ].filter((s) => !filtering || s.items.length > 0);
  const history = rows.filter((r) => !opened.has(sessionRowKey(r)));
  return { sections, history };
}

// ---- child sessions (model: Session.parent) ----
//
// A child session is a full session opened under another one ("New child
// session"). In the list it sits under its parent instead of at the top
// level — as long as the parent is listed; an orphan stays where it was.

export type ChildItem = {
  // null: the child's tab is open but claude hasn't named the session yet.
  row: SessionRow | null;
  // The open tab showing it in this project, if any.
  tabId: string | null;
  title: string;
};
export type ChildIndex = {
  // Parent session id → its children, oldest activity first, unstarted last.
  childrenOf: Map<string, ChildItem[]>;
  // What to leave out of the top level.
  childRowKeys: Set<string>;
  childTabIds: Set<string>;
};

export function childSessions(input: {
  // The project `tabs` belong to.
  projectId: string;
  // Every listed row a child or parent may be among.
  rows: readonly SessionRow[];
  tabs: readonly SectionTab[];
}): ChildIndex {
  const { projectId, rows, tabs } = input;
  const claude = rows.filter((r) => r.kind === 'claude');
  const parentKey = (pid: string, sid: string) => `${pid}:${sid}`;
  const listed = new Set(claude.map((r) => parentKey(r.projectId, r.sessionId)));
  const childrenOf = new Map<string, ChildItem[]>();
  const childRowKeys = new Set<string>();
  const childTabIds = new Set<string>();
  const add = (parent: string, item: ChildItem) => childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item]);
  for (const r of [...claude].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (!r.parentId || !listed.has(parentKey(r.projectId, r.parentId))) continue;
    const tab = r.projectId === projectId ? tabs.find((t) => tabKind(t) === 'claude' && t.resumeId === r.sessionId) : undefined;
    add(r.parentId, { row: r, tabId: tab?.id ?? null, title: r.title });
    childRowKeys.add(sessionRowKey(r));
    if (tab) childTabIds.add(tab.id);
  }
  for (const t of tabs) {
    if (tabKind(t) !== 'claude' || t.resumeId || !t.parentSessionId || !listed.has(parentKey(projectId, t.parentSessionId))) continue;
    add(t.parentSessionId, { row: null, tabId: t.id, title: t.title?.trim() || 'New child session' });
    childTabIds.add(t.id);
  }
  return { childrenOf, childRowKeys, childTabIds };
}
