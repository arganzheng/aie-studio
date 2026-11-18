import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { archiveSession, deleteSessionForever, listAllSessions, renameAnySession, stopSession, type SubagentInfo } from '../api';
import { useFitMenuTop } from '../lib/fitMenu';
import {
  NO_FILTER, childSessions, filterSessions, isFiltering, sectionSessions, sessionRowKey, sessionStatus,
  type SectionGroup, type SectionTab, type SessionFilter, type SessionKind, type SessionRow, type SessionSection,
} from '../lib/sessionList';
import { groupActivityMark, type TabActivity } from '../lib/tabActivity';
import { TabActivityMark } from './TabActivityMark';
import { tabGroupId } from '../types';
import { providerIcon } from './TabBar';
import { SessionSubagents } from './SessionSubagents';

// Model: web.SessionList — the sidebar's Sessions view: every Claude and
// Devin session of this project (or of all projects), newest first, with
// what it is doing right now. Click a row to open or go to the session; the
// ⋯ menu renames, archives, stops and deletes. Fed by server.ListAllSessions,
// refreshed on a timer while visible and whenever `refreshSignal` changes
// (a session event arrived).
//
// It also hosts the project's tab Groups (the former Groups view): in the
// "This project" scope the list is split into one section per Group — its
// open session tabs, in tab order — then a History section for sessions with
// no open tab. A section header switches to that Group; its ⋯ menu renames
// or deletes it; headers drag to reorder, and session rows drag onto a
// section (or use "Move to …") to move their tab. "All projects" and the
// Archived filter keep the flat list: Groups are per project.

const POLL_MS = 5000;
const SCOPE_LS_KEY = 'remote-ide:sessionListScope';
const COLLAPSED_LS_KEY = 'remote-ide:sessionSectionsCollapsed';
const HISTORY_ID = '__history__';
const SUBAGENTS_OPEN_LS_KEY = 'remote-ide:sessionSubagentsOpen';

type Scope = 'project' | 'all';

function loadScope(): Scope {
  try { return localStorage.getItem(SCOPE_LS_KEY) === 'all' ? 'all' : 'project'; } catch { return 'project'; }
}
function loadStringSet(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_LS_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch { return new Set(); }
}

// The project's tab Groups, owned by App.
export type SessionListWorkspace = {
  tabs: readonly SectionTab[];
  groups: readonly SectionGroup[];
  defaultGroupName: string;
  activeGroupId: string;
  activeTabId: string | null;
  activity: Readonly<Record<string, TabActivity>>;
  onSelectGroup: (groupId: string) => void;
  onActivateTab: (tabId: string) => void;
  onCreateGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
  onReorderGroups: (next: SectionGroup[]) => void;
  onMoveTab: (tabId: string, groupId: string) => void;
};

type Menu =
  | { kind: 'row'; row: SessionRow | null; tabId: string | null; groupId: string | null; top: number; left: number }
  | { kind: 'group'; groupId: string; top: number; left: number };
type Drag = { kind: 'group'; id: string } | { kind: 'tab'; id: string; from: string };
type Drop = { id: string; pos: 'before' | 'after' | 'into' };

export function SessionList({
  projectId,
  projectNames,
  unread,
  activeKey,
  refreshSignal,
  workspace,
  activeSubagent,
  onOpen,
  onOpenSubagent,
  onNewChild,
  onNewClaude,
  onNewDevin,
  onRenamed,
  onDeleted,
  onNotice,
}: {
  projectId: string;
  projectNames: ReadonlyMap<string, string>;
  // Row keys (lib/sessionList.sessionRowKey) with a pending alert.
  unread: ReadonlySet<string>;
  // The session in the tab on screen, if any.
  activeKey: string | null;
  refreshSignal: number;
  // Present → Group sections in the "This project" scope.
  workspace?: SessionListWorkspace;
  // The subagent in the tab on screen, if any: `<sessionId>:<agentId>`.
  activeSubagent?: string | null;
  onOpen: (row: SessionRow) => void;
  // A subagent row under an expanded Claude session was clicked.
  onOpenSubagent?: (row: SessionRow, s: SubagentInfo) => void;
  // "New child session" on a Claude session's menu. Omitted when Claude is
  // switched off on this device.
  onNewChild?: (row: SessionRow) => void;
  // Omitted when that provider is switched off on this device.
  onNewClaude?: () => void;
  onNewDevin?: () => void;
  // The caller owns the tabs: it retitles / closes the ones showing the session.
  onRenamed: (row: SessionRow, title: string) => void;
  onDeleted: (row: SessionRow) => void;
  onNotice: (text: string) => void;
}) {
  const [scope, setScope] = useState<Scope>(loadScope);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SessionFilter>(NO_FILTER);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; text: string } | null>(null);
  const [groupRenaming, setGroupRenaming] = useState<{ id: string; text: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  // Session rows (sessionRowKey) whose subagents are shown.
  const [subagentsOpen, setSubagentsOpen] = useState<Set<string>>(() => loadStringSet(SUBAGENTS_OPEN_LS_KEY));
  const [tick, setTick] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTop = useFitMenuTop(menuRef, menu, menu?.top ?? 0);
  const seq = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(SCOPE_LS_KEY, scope); } catch {}
  }, [scope]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_LS_KEY, JSON.stringify([...collapsed])); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(SUBAGENTS_OPEN_LS_KEY, JSON.stringify([...subagentsOpen].slice(-200))); } catch {}
  }, [subagentsOpen]);

  const target = scope === 'all' ? 'all' : projectId;
  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const list = await listAllSessions(target);
      if (my !== seq.current) return;
      setRows(list);
      setError(null);
    } catch (e) {
      if (my !== seq.current) return;
      setError((e as Error).message);
    }
    setNow(Date.now());
    setTick((n) => n + 1);
  }, [target]);

  // A different project / scope: drop the old rows rather than show them
  // under the new heading while the fetch is out.
  useEffect(() => { setRows(null); }, [target]);
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, refreshSignal]);

  useEffect(() => {
    if (!menu && !newMenuOpen) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.('.sessions-new')) return;
      setMenu(null);
      setNewMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menu, newMenuOpen]);

  const shown = useMemo(() => filterSessions(rows ?? [], filter, unread), [rows, filter, unread]);
  const archivedCount = useMemo(() => (rows ?? []).filter((r) => r.archived).length, [rows]);
  const filtering = filter.query.trim() !== '' || isFiltering(filter);

  // Sections only where Groups mean something: this project, current sessions.
  const sectioned = useMemo(() => {
    if (!workspace || scope !== 'project' || filter.archived || rows === null) return null;
    return sectionSessions({
      projectId,
      rows: shown,
      allRows: rows.filter((r) => !r.archived),
      tabs: workspace.tabs,
      groups: workspace.groups,
      defaultName: workspace.defaultGroupName,
      filtering,
    });
  }, [workspace, scope, filter.archived, rows, shown, projectId, filtering]);

  // Child sessions sit under their parent rather than at the top level —
  // except while searching / filtering, where every match is listed flat.
  const kids = useMemo(() => {
    if (filtering || rows === null) return null;
    return childSessions({ projectId, rows: filter.archived ? shown : rows.filter((r) => !r.archived), tabs: workspace?.tabs ?? [] });
  }, [filtering, rows, shown, filter.archived, projectId, workspace?.tabs]);

  async function act(what: string, fn: () => Promise<void>) {
    setMenu(null);
    try {
      await fn();
    } catch (e) {
      onNotice(`${what} failed: ${(e as Error).message}`);
    }
    void refresh();
  }

  function commitRename(row: SessionRow) {
    const text = renaming?.text.trim() ?? '';
    setRenaming(null);
    if (!text || text === row.title) return;
    void act('Rename', async () => {
      const title = await renameAnySession(row, text);
      onRenamed(row, title);
    });
  }

  function commitGroupRename() {
    if (!groupRenaming || !workspace) return;
    workspace.onRenameGroup(groupRenaming.id, groupRenaming.text);
    setGroupRenaming(null);
  }

  function confirmDelete(row: SessionRow) {
    setMenu(null);
    const running = row.live ? '\n\nIt is running now and will be stopped first.' : '';
    if (!window.confirm(`Delete "${row.title}"?\n\nIts transcript is removed for good — this cannot be undone.${running}`)) return;
    void act('Delete', async () => {
      await deleteSessionForever(row);
      onDeleted(row);
    });
  }

  function startNew(kind: SessionKind) {
    setNewMenuOpen(false);
    if (kind === 'claude') onNewClaude?.(); else onNewDevin?.();
  }
  const newKinds: SessionKind[] = [...(onNewClaude ? ['claude' as const] : []), ...(onNewDevin ? ['devin' as const] : [])];

  function toggleCollapsed(id: string) {
    const key = `${projectId}:${id}`;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const isCollapsed = (id: string) => collapsed.has(`${projectId}:${id}`) && !filtering;

  function menuAt(e: React.MouseEvent, width: number) {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    return { top: r.bottom + 2, left: Math.max(4, Math.min(r.right - width, window.innerWidth - width - 14)) };
  }

  // ---- drag and drop (HTML5; mouse only — touch uses the menus) ----
  function endDrag() { setDrag(null); setDrop(null); }

  function onSectionDragOver(e: React.DragEvent, s: SessionSection) {
    if (!drag) return;
    if (drag.kind === 'tab') {
      if (drag.from === s.groupId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drop?.id !== s.groupId || drop.pos !== 'into') setDrop({ id: s.groupId, pos: 'into' });
      return;
    }
    // Reordering: user Groups only, onto another user Group's header.
    if (s.isDefault || drag.id === s.groupId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drop?.id !== s.groupId || drop.pos !== pos) setDrop({ id: s.groupId, pos });
  }

  function onSectionDrop(e: React.DragEvent, s: SessionSection) {
    e.preventDefault();
    const d = drag;
    const target = drop?.id === s.groupId ? drop : null;
    endDrag();
    if (!d || !target || !workspace) return;
    if (d.kind === 'tab') { workspace.onMoveTab(d.id, s.groupId); return; }
    const groups = workspace.groups;
    const moved = groups.find((g) => g.id === d.id);
    if (!moved) return;
    const without = groups.filter((g) => g.id !== d.id);
    let idx = without.findIndex((g) => g.id === s.groupId);
    if (idx < 0) return;
    if (target.pos === 'after') idx += 1;
    const next = [...without.slice(0, idx), moved, ...without.slice(idx)];
    if (next.every((g, i) => g.id === groups[i]?.id)) return;
    workspace.onReorderGroups(next);
  }

  const seg = <T extends string>(value: T, options: ReadonlyArray<readonly [T, string]>, onPick: (v: T) => void) => (
    <div className="sessions-seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onPick(v)}>{label}</button>
      ))}
    </div>
  );

  // One session line. `tabId`/`groupId` are set for rows inside a Group
  // section (an open tab); `row` is null for a tab not listed yet.
  function renderRow(row: SessionRow | null, opts: { tabId?: string; groupId?: string; title?: string; kind?: SessionKind; depth?: number } = {}): ReactNode {
    const key = row ? sessionRowKey(row) : `tab:${opts.tabId}`;
    const isUnread = row ? unread.has(key) : false;
    const status = row ? sessionStatus(row, isUnread, now) : { tone: 'idle' as const, label: 'Not started' };
    const project = row && scope === 'all' ? projectNames.get(row.projectId) : undefined;
    const editing = row !== null && renaming?.key === key;
    const kind = row?.kind ?? opts.kind ?? 'claude';
    const isActive = opts.tabId ? opts.tabId === workspace?.activeTabId : key === activeKey;
    const draggable = !!(opts.tabId && opts.groupId && workspace && !editing);
    const depth = opts.depth ?? 0;
    const subs = row?.kind === 'claude' && row.subagents && row.subagents.total > 0 ? row.subagents : null;
    // Child sessions of this one (capped depth: a link cycle can't recurse forever).
    const children = (row?.kind === 'claude' && depth < 4 && kids?.childrenOf.get(row.sessionId)) || [];
    const hasTree = subs !== null || children.length > 0;
    const childRunning = children.filter((c) => c.row?.state === 'running' || c.row?.state === 'awaiting').length;
    const treeTotal = (subs?.total ?? 0) + children.length;
    const treeRunning = (subs?.running ?? 0) + childRunning;
    const subsOpen = hasTree && subagentsOpen.has(key);
    const toggleSubs = (e: React.MouseEvent) => {
      e.stopPropagation();
      setSubagentsOpen((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    };
    return (
      <Fragment key={key}>
      <div
        className={`session-row tone-${status.tone}${isActive ? ' active' : ''}${row?.archived ? ' archived' : ''}${drag?.kind === 'tab' && drag.id === opts.tabId ? ' dragging' : ''}${depth > 0 ? ' child' : ''}`}
        style={depth > 0 ? { paddingLeft: 12 + depth * 18 } : undefined}
        title={row?.title ?? opts.title}
        draggable={draggable}
        onDragStart={draggable ? (e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', opts.tabId!);
          setDrag({ kind: 'tab', id: opts.tabId!, from: opts.groupId! });
        } : undefined}
        onDragEnd={endDrag}
        onClick={() => {
          if (editing) return;
          if (opts.tabId && workspace) workspace.onActivateTab(opts.tabId);
          else if (row) onOpen(row);
        }}
      >
        {hasTree ? (
          <button
            type="button"
            style={depth > 0 ? { left: depth * 18 } : undefined}
            className="session-row-caret"
            aria-label={subsOpen ? 'Hide child sessions and subagents' : 'Show child sessions and subagents'}
            aria-expanded={subsOpen}
            onClick={toggleSubs}
          >{subsOpen ? '▾' : '▸'}</button>
        ) : null}
        <span className="session-row-icon">{providerIcon(kind === 'devin' ? 'devin' : 'session')}</span>
        <div className="session-row-main">
          {editing ? (
            <input
              autoFocus
              className="tree-rename"
              value={renaming!.text}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming({ key, text: e.target.value })}
              onBlur={() => commitRename(row!)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(row!); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
              }}
            />
          ) : (
            <div className="session-row-title">{row?.title ?? opts.title}</div>
          )}
          <div className="session-row-sub">
            <span className="session-row-status">{status.label}</span>
            {project && <span> · {project}</span>}
          </div>
        </div>
        {hasTree && (
          <button
            type="button"
            className={`session-row-subagents${treeRunning > 0 ? ' running' : ''}`}
            title={`${[
              children.length > 0 ? `${children.length} child session${children.length === 1 ? '' : 's'}` : '',
              subs ? `${subs.total} subagent${subs.total === 1 ? '' : 's'}` : '',
            ].filter(Boolean).join(', ')}${treeRunning > 0 ? ` — ${treeRunning} running` : ' — none running'}; click to ${subsOpen ? 'hide' : 'show'}`}
            onClick={toggleSubs}
          >⑂ {treeTotal - treeRunning}/{treeTotal}</button>
        )}
        {(status.tone === 'awaiting' || status.tone === 'running' || isUnread) && (
          <span className={`session-row-dot ${status.tone}`} aria-hidden="true" />
        )}
        <button
          type="button"
          className="session-row-menu-btn"
          title="More"
          aria-label="More"
          onClick={(e) => setMenu({ kind: 'row', row, tabId: opts.tabId ?? null, groupId: opts.groupId ?? null, ...menuAt(e, 200) })}
        >⋯</button>
      </div>
      {subsOpen && row && subs && (
        <SessionSubagents
          projectId={row.projectId}
          sessionId={row.sessionId}
          tick={tick}
          total={subs.total}
          running={subs.running}
          now={now}
          activeAgentId={activeSubagent?.startsWith(`${row.sessionId}:`) ? activeSubagent.slice(row.sessionId.length + 1) : null}
          onOpen={(s) => onOpenSubagent?.(row, s)}
          onNotice={onNotice}
        />
      )}
      {subsOpen && children.map((c) => renderRow(c.row, { tabId: c.tabId ?? undefined, title: c.title, kind: 'claude', depth: depth + 1 }))}
      </Fragment>
    );
  }

  const topLevel = (list: readonly SessionRow[]) => (kids ? list.filter((r) => !kids.childRowKeys.has(sessionRowKey(r))) : list);

  function renderSection(s: SessionSection): ReactNode {
    const ws = workspace!;
    const closed = isCollapsed(s.groupId);
    const isActive = s.groupId === ws.activeGroupId;
    const renamingThis = groupRenaming?.id === s.groupId;
    const dropCls = drop?.id === s.groupId ? ` drop-${drop.pos}` : '';
    const dragCls = drag?.kind === 'group' && drag.id === s.groupId ? ' dragging' : '';
    return (
      <div
        key={s.groupId}
        className={`sessions-section${isActive ? ' active' : ''}${dropCls}${dragCls}`}
        onDragOver={(e) => onSectionDragOver(e, s)}
        onDragLeave={(e) => { if (drop?.id === s.groupId && !e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null); }}
        onDrop={(e) => onSectionDrop(e, s)}
      >
        <div
          className="sessions-section-head"
          draggable={!s.isDefault && !renamingThis}
          onDragStart={(e) => {
            if (s.isDefault) { e.preventDefault(); return; }
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', s.groupId);
            setDrag({ kind: 'group', id: s.groupId });
          }}
          onDragEnd={endDrag}
          onClick={() => { if (!renamingThis) ws.onSelectGroup(s.groupId); }}
          onDoubleClick={() => { if (!s.isDefault) setGroupRenaming({ id: s.groupId, text: s.name }); }}
          title={s.isDefault ? 'Default group (cannot be deleted) — click to switch to it' : `${s.name} — click to switch to this group`}
        >
          <button
            type="button"
            className="sessions-section-caret"
            aria-label={closed ? 'Expand' : 'Collapse'}
            aria-expanded={!closed}
            onClick={(e) => { e.stopPropagation(); toggleCollapsed(s.groupId); }}
          >{closed ? '▸' : '▾'}</button>
          <span className="sessions-section-icon">{s.isDefault ? '▣' : '▢'}</span>
          {renamingThis ? (
            <input
              autoFocus
              className="group-rename"
              value={groupRenaming!.text}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setGroupRenaming({ id: s.groupId, text: e.target.value })}
              onBlur={commitGroupRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroupRename();
                if (e.key === 'Escape') setGroupRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="sessions-section-name">{s.name}</span>
          )}
          <TabActivityMark mark={groupActivityMark(ws.tabs, ws.activity, s.groupId, tabGroupId)} />
          <span className="sessions-section-count" title={`${s.tabCount} tab${s.tabCount === 1 ? '' : 's'}`}>{s.tabCount}</span>
          {!s.isDefault && !renamingThis && (
            <button
              type="button"
              className="sessions-section-menu-btn"
              title="Group menu"
              aria-label="Group menu"
              onClick={(e) => setMenu({ kind: 'group', groupId: s.groupId, ...menuAt(e, 200) })}
            >⋯</button>
          )}
        </div>
        {!closed && (
          <>
            {s.items.filter((it) => !kids?.childTabIds.has(it.tabId)).map((it) => renderRow(it.row, { tabId: it.tabId, groupId: s.groupId, title: it.title, kind: it.kind }))}
            {s.otherTabs > 0 && (
              <div className="sessions-section-note" onClick={() => ws.onSelectGroup(s.groupId)}>
                + {s.otherTabs} other tab{s.otherTabs === 1 ? '' : 's'}
              </div>
            )}
            {s.tabCount === 0 && <div className="sessions-section-note">Empty — new tabs open in the selected group</div>}
            {s.tabCount > 0 && s.items.length === 0 && s.otherTabs === 0 && (
              <div className="sessions-section-note">No sessions</div>
            )}
            {(() => {
              const nested = s.items.filter((it) => kids?.childTabIds.has(it.tabId)).length;
              return nested > 0 && nested === s.items.length
                ? <div className="sessions-section-note">{nested} child session tab{nested === 1 ? '' : 's'} — listed under {nested === 1 ? 'its' : 'their'} parent</div>
                : null;
            })()}
          </>
        )}
      </div>
    );
  }

  function renderBody(): ReactNode {
    if (error) return <div className="sessions-empty error">{error}</div>;
    if (rows === null) return <div className="sessions-empty">Loading…</div>;
    if (sectioned) {
      const { sections, history } = sectioned;
      const historyClosed = isCollapsed(HISTORY_ID);
      if (sections.length === 0 && history.length === 0) {
        return <div className="sessions-empty">{rows.length === 0 ? 'No sessions yet — start one with ＋' : 'No sessions match'}</div>;
      }
      return (
        <>
          {sections.map(renderSection)}
          {history.length > 0 && (
            <div className="sessions-section history">
              <div className="sessions-section-head" onClick={() => toggleCollapsed(HISTORY_ID)} title="Sessions with no open tab">
                <span className="sessions-section-caret" aria-hidden="true">{historyClosed ? '▸' : '▾'}</span>
                <span className="sessions-section-name">History</span>
                <span className="sessions-section-count">{topLevel(history).length}</span>
              </div>
              {!historyClosed && topLevel(history).map((r) => renderRow(r))}
            </div>
          )}
        </>
      );
    }
    if (shown.length === 0) {
      return (
        <div className="sessions-empty">
          {rows.length === 0 ? 'No sessions yet — start one with ＋'
            : filter.archived ? 'Nothing archived'
            : 'No sessions match'}
        </div>
      );
    }
    return topLevel(shown).map((r) => renderRow(r));
  }

  const menuGroup = menu?.kind === 'group' ? workspace?.groups.find((g) => g.id === menu.groupId) : undefined;
  const moveTargets = menu?.kind === 'row' && menu.tabId && workspace
    ? [
        ...workspace.groups.map((g) => ({ id: g.id, name: g.name })),
        { id: 'default', name: workspace.defaultGroupName },
      ].filter((g) => g.id !== menu.groupId)
    : [];

  return (
    <div className="sessions-view">
      <div className="sessions-head">
        <span className="sessions-title">Sessions</span>
        {workspace && scope === 'project' && (
          <button
            type="button"
            className="sessions-icon-btn"
            title="New group"
            aria-label="New group"
            onClick={workspace.onCreateGroup}
          >⊞</button>
        )}
        {newKinds.length > 0 && (
          <div className="sessions-new">
            <button
              type="button"
              className="sessions-icon-btn"
              title="New session"
              aria-label="New session"
              onClick={() => (newKinds.length === 1 ? startNew(newKinds[0]) : setNewMenuOpen((v) => !v))}
            >＋</button>
            {newMenuOpen && (
              <div className="sessions-new-menu">
                {newKinds.map((k) => (
                  <button key={k} type="button" className="overflow-action" onClick={() => startNew(k)}>
                    <span className="sessions-new-icon">{providerIcon(k === 'devin' ? 'devin' : 'session')}</span>
                    {k === 'devin' ? 'New Devin session' : 'New Claude session'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className={`sessions-icon-btn${filtersOpen || isFiltering(filter) || scope === 'all' ? ' on' : ''}`}
          title="Scope and filters"
          aria-label="Scope and filters"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((v) => !v)}
        >⚙</button>
      </div>
      <input
        className="sessions-search"
        type="search"
        placeholder="Search sessions"
        value={filter.query}
        onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
      />
      {filtersOpen && (
        <div className="sessions-filters">
          {seg(scope, [['project', 'This project'], ['all', 'All projects']] as const, setScope)}
          {seg(filter.kind, [['all', 'All'], ['claude', 'Claude'], ['devin', 'Devin']] as const, (kind) => setFilter((f) => ({ ...f, kind })))}
          {seg(filter.status, [['all', 'Any status'], ['active', 'Active']] as const, (status) => setFilter((f) => ({ ...f, status })))}
          {seg(filter.archived ? 'archived' : 'current', [['current', 'Current'], ['archived', `Archived${archivedCount ? ` (${archivedCount})` : ''}`]] as const, (v) => setFilter((f) => ({ ...f, archived: v === 'archived' })))}
        </div>
      )}
      <div className="sessions-list">{renderBody()}</div>
      {menu?.kind === 'row' && createPortal(
        <div ref={menuRef} className="tab-overflow-menu" style={{ top: menuTop, left: menu.left }}>
          <button
            className="overflow-action"
            onClick={() => {
              setMenu(null);
              if (menu.tabId && workspace) workspace.onActivateTab(menu.tabId);
              else if (menu.row) onOpen(menu.row);
            }}
          >↗ Open</button>
          {menu.row && (
            <button
              className="overflow-action"
              onClick={() => { const row = menu.row!; setMenu(null); setRenaming({ key: sessionRowKey(row), text: row.title }); }}
            >✎ Rename</button>
          )}
          {menu.row?.kind === 'claude' && onNewChild && (
            <button
              className="overflow-action"
              title="Start a new Claude session filed under this one"
              onClick={() => {
                const row = menu.row!;
                setMenu(null);
                setSubagentsOpen((prev) => new Set(prev).add(sessionRowKey(row)));
                onNewChild(row);
              }}
            >＋ New child session</button>
          )}
          {moveTargets.map((g) => (
            <button
              key={g.id}
              className="overflow-action"
              onClick={() => { const tabId = menu.tabId!; setMenu(null); workspace!.onMoveTab(tabId, g.id); }}
            >⇢ Move to {g.name}</button>
          ))}
          {menu.row && (
            <button
              className="overflow-action"
              onClick={() => { const row = menu.row!; void act(row.archived ? 'Unarchive' : 'Archive', () => archiveSession(row, !row.archived)); }}
            >{menu.row.archived ? '↩ Unarchive' : '🗄 Archive'}</button>
          )}
          {menu.row?.live && (
            <button
              className="overflow-action"
              onClick={() => { const row = menu.row!; void act('Stop', async () => { await stopSession(row); }); }}
            >■ Stop</button>
          )}
          {menu.row?.kind === 'claude' && (
            <button className="overflow-action danger" onClick={() => confirmDelete(menu.row!)}>🗑 Delete…</button>
          )}
        </div>,
        document.body,
      )}
      {menu?.kind === 'group' && menuGroup && workspace && createPortal(
        <div ref={menuRef} className="tab-overflow-menu" style={{ top: menuTop, left: menu.left }}>
          <button className="overflow-action" onClick={() => { setMenu(null); workspace.onSelectGroup(menuGroup.id); }}>↗ Switch to group</button>
          <button className="overflow-action" onClick={() => { setMenu(null); setGroupRenaming({ id: menuGroup.id, text: menuGroup.name }); }}>✎ Rename group</button>
          <button className="overflow-action danger" onClick={() => { setMenu(null); workspace.onDeleteGroup(menuGroup.id); }}>🗑 Delete group…</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
