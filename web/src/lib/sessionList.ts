// Model: web.SessionList — the sidebar's list of every AI session (Claude and
// Devin), fed by server.ListAllSessions. Pure helpers only: filtering, the
// status line, relative times.

import type { SessionStatus } from './sessionStatus';

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
  // The batch label its parent's agent gave it (children opened together).
  group?: string;
  // Claude (SDK bridge): the tool call its running turn last made.
  activity?: string;
  // What its agent said it is waiting for when its last turn ended.
  status?: SessionStatus;
};

// Is the session stopped on the user: a form or prompt is open, or its agent
// ended the turn on a question.
export function needsUser(r: Pick<SessionRow, 'state' | 'status'>): boolean {
  return r.state === 'awaiting' || (r.state !== 'running' && r.status?.tone === 'needs-you');
}

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
    if (f.status === 'active' && r.state !== 'running' && !needsUser(r) && !unread.has(sessionRowKey(r))) return false;
    if (q && !r.title.toLowerCase().includes(q) && !r.sessionId.toLowerCase().startsWith(q)) return false;
    return true;
  });
}

export type SessionTone = 'awaiting' | 'running' | 'ready' | 'unread' | 'idle';

// What the row's second line says. A question outranks a spinner, which
// outranks what the agent left when it stopped (its question, or what it has
// ready), which outranks "there is a result you haven't looked at".
export function sessionStatus(r: SessionRow, unread: boolean, now: number): { tone: SessionTone; label: string } {
  if (r.state === 'awaiting') return { tone: 'awaiting', label: 'Needs your input' };
  if (r.state === 'running') return { tone: 'running', label: r.activity || 'Running…' };
  if (r.status) return { tone: r.status.tone === 'needs-you' ? 'awaiting' : 'ready', label: r.status.label };
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

// ---- Open tabs: which listed sessions have a tab, and which tabs aren't listed yet
//
// The list itself stays flat and ordered by activity (model: web.SessionList
// rule "flat"): opening or closing a tab never moves a row, it only toggles
// the row's "open" mark.

// The slice of a Tab this needs (web/src/types.ts Tab).
export type SessionTabLike = { id: string; type: string; resumeId?: string; title?: string; parentSessionId?: string };

export type PendingTab = {
  tabId: string;
  kind: SessionKind;
  title: string;
};
export type OpenTabs = {
  // sessionRowKey → the open tab showing it (the first one, if several).
  tabOf: Map<string, string>;
  // Session tabs with no listed session yet (a fresh tab before its first
  // reply, or the list hasn't caught up), in tab order.
  pending: PendingTab[];
};

function tabKind(t: SessionTabLike): SessionKind | null {
  if (t.type === 'devin') return 'devin';
  if (t.type === 'session' || t.type === 'claude-sdk') return 'claude';
  return null;
}

export function openSessionTabs(input: {
  projectId: string;
  // Every listed row, before filtering (archived ones too).
  allRows: readonly SessionRow[];
  tabs: readonly SessionTabLike[];
}): OpenTabs {
  const { projectId, allRows, tabs } = input;
  const listed = new Set(allRows.map(sessionRowKey));
  const tabOf = new Map<string, string>();
  const pending: PendingTab[] = [];
  for (const t of tabs) {
    const kind = tabKind(t);
    if (!kind) continue;
    const key = t.resumeId ? sessionRowKey({ projectId, kind, sessionId: t.resumeId }) : null;
    if (key && listed.has(key)) {
      if (!tabOf.has(key)) tabOf.set(key, t.id);
      continue;
    }
    pending.push({ tabId: t.id, kind, title: t.title || (kind === 'devin' ? 'New Devin session' : 'New session') });
  }
  return { tabOf, pending };
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
  tabs: readonly SessionTabLike[];
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

// ---- child groups (model: SessionMeta.groups) ----
//
// Children their parent's agent opened as one batch share a label; the tree
// nests them under it with a done/total count. Order follows the children:
// a group sits where its first member would.

export type ChildGroupNode =
  | { kind: 'child'; item: ChildItem }
  | { kind: 'group'; label: string; items: ChildItem[]; total: number; running: number };

export function groupChildren(children: readonly ChildItem[]): ChildGroupNode[] {
  const out: ChildGroupNode[] = [];
  const byLabel = new Map<string, Extract<ChildGroupNode, { kind: 'group' }>>();
  for (const item of children) {
    const label = item.row?.group?.trim();
    if (!label) { out.push({ kind: 'child', item }); continue; }
    let g = byLabel.get(label);
    if (!g) { g = { kind: 'group', label, items: [], total: 0, running: 0 }; byLabel.set(label, g); out.push(g); }
    g.items.push(item);
    g.total++;
    if (item.row?.state === 'running' || item.row?.state === 'awaiting') g.running++;
  }
  return out;
}

// ---- project sections (model: web.SessionList rule "by project") ----
//
// The list shows every project at once: one foldable section per project, in
// the project list's order, each holding that project's sessions. A section's
// counts tell what is going on inside it while it is folded.

export type ProjectSection = {
  projectId: string;
  name: string;
  // This project's rows, in the order they were given.
  rows: SessionRow[];
  // Sessions working now, waiting on the user, and holding an unread alert.
  running: number;
  awaiting: number;
  unread: number;
};

export function sessionsByProject(input: {
  // Project id → name, in the project list's order.
  projects: ReadonlyMap<string, string>;
  rows: readonly SessionRow[];
  unread: ReadonlySet<string>;
  // This project's section is kept even when it has no rows.
  keepEmpty?: string | null;
}): ProjectSection[] {
  const { projects, rows, unread, keepEmpty } = input;
  const byId = new Map<string, ProjectSection>();
  const section = (projectId: string): ProjectSection => {
    let s = byId.get(projectId);
    if (!s) {
      s = { projectId, name: projects.get(projectId) ?? 'Unknown project', rows: [], running: 0, awaiting: 0, unread: 0 };
      byId.set(projectId, s);
    }
    return s;
  };
  // Listed projects first, in their order; a row of a project that isn't
  // listed (just removed) lands in a section after them.
  for (const id of projects.keys()) section(id);
  for (const r of rows) {
    const s = section(r.projectId);
    s.rows.push(r);
    if (needsUser(r)) s.awaiting++;
    else if (r.state === 'running') s.running++;
    if (unread.has(sessionRowKey(r))) s.unread++;
  }
  return [...byId.values()].filter((s) => s.rows.length > 0 || s.projectId === keepEmpty);
}

// ---- status groups (model: web.SessionList rule "by status") ----
//
// The other way to lay the list out: every project's sessions together, in
// one group per what they need — the user first, then what is working, then
// what has a result to look at, then the rest. Inside a group the rows keep
// the order they were given (newest first).

export type StatusGroupId = 'needs-you' | 'working' | 'ready' | 'other';

export const STATUS_GROUPS: ReadonlyArray<{ id: StatusGroupId; label: string }> = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'ready', label: 'Ready to review' },
  { id: 'other', label: 'Other' },
];

export function statusGroupOf(tone: SessionTone): StatusGroupId {
  if (tone === 'awaiting') return 'needs-you';
  if (tone === 'running') return 'working';
  if (tone === 'ready' || tone === 'unread') return 'ready';
  return 'other';
}

export type StatusSection = { id: StatusGroupId; label: string; rows: SessionRow[] };

// Empty groups are left out.
export function sessionsByStatus(input: {
  rows: readonly SessionRow[];
  unread: ReadonlySet<string>;
  now: number;
}): StatusSection[] {
  const { rows, unread, now } = input;
  const byId = new Map<StatusGroupId, SessionRow[]>(STATUS_GROUPS.map((g) => [g.id, []]));
  for (const r of rows) byId.get(statusGroupOf(sessionStatus(r, unread.has(sessionRowKey(r)), now).tone))!.push(r);
  return STATUS_GROUPS.map((g) => ({ ...g, rows: byId.get(g.id)! })).filter((s) => s.rows.length > 0);
}
