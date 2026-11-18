import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { archiveSession, deleteSessionForever, listAllSessions, renameAnySession, stopSession, type SubagentInfo } from '../api';
import { useFitMenuTop } from '../lib/fitMenu';
import {
  NO_FILTER, childSessions, groupChildren, filterSessions, isFiltering, openSessionTabs, sessionRowKey, sessionStatus,
  type SessionFilter, type SessionKind, type SessionRow, type SessionTabLike,
} from '../lib/sessionList';
import { providerIcon } from './TabBar';
import { SessionSubagents } from './SessionSubagents';

// Model: web.SessionList — the sidebar's Sessions view: every Claude and
// Devin session of this project (or of all projects), newest first, with
// what it is doing right now. Click a row to open or go to the session; the
// ⋯ menu renames, archives, stops and deletes. Fed by server.ListAllSessions,
// refreshed on a timer while visible and whenever `refreshSignal` changes
// (a session event arrived).
//
// The list is flat (model: web.SessionList rule "flat"): opening or closing a
// session's tab never moves its row, it only toggles the row's "open" mark,
// and clicking an open row goes to its tab. Session tabs that aren't listed
// yet (a fresh session before its first reply) sit on top.

const POLL_MS = 5000;
const SCOPE_LS_KEY = 'remote-ide:sessionListScope';
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

// The active project's open tabs, owned by App.
export type SessionListWorkspace = {
  tabs: readonly SessionTabLike[];
  activeTabId: string | null;
  onActivateTab: (tabId: string) => void;
};

type Menu = { row: SessionRow | null; tabId: string | null; top: number; left: number };

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
  // Present → rows with an open tab are marked and go to it.
  workspace?: SessionListWorkspace;
  // The subagent in the tab on screen, if any: `<sessionId>:<agentId>`.
  activeSubagent?: string | null;
  onOpen: (row: SessionRow) => void;
  // A subagent row under an expanded Claude session was clicked.
  onOpenSubagent?: (row: SessionRow, s: SubagentInfo) => void;
  // "New child session" on a Claude session's menu. Omitted when Claude is
  // switched off on this device.
  onNewChild?: (row: SessionRow, mode: 'plain' | 'worktree' | 'compacted') => void;
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
  // Session rows (sessionRowKey) whose subagents are shown.
  const [subagentsOpen, setSubagentsOpen] = useState<Set<string>>(() => loadStringSet(SUBAGENTS_OPEN_LS_KEY));
  const [tick, setTick] = useState(0);
  // Child groups the user folded (`<session row key>:<label>`); open by default.
  const [groupsClosed, setGroupsClosed] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTop = useFitMenuTop(menuRef, menu, menu?.top ?? 0);
  const seq = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(SCOPE_LS_KEY, scope); } catch {}
  }, [scope]);
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

  // Which rows have an open tab in this project, and the session tabs not listed yet.
  const openTabs = useMemo(
    () => (workspace && rows !== null ? openSessionTabs({ projectId, allRows: rows, tabs: workspace.tabs }) : null),
    [workspace, rows, projectId],
  );

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

  function confirmDelete(row: SessionRow) {
    setMenu(null);
    const running = row.live ? '\n\nIt is running now and will be stopped first.' : '';
    if (!window.confirm(`Delete "${row.title}"?\n\nIts transcript is removed for good — this cannot be undone.${running}`)) return;
    void act('Delete', async () => {
      const { worktree } = await deleteSessionForever(row);
      onDeleted(row);
      if (worktree) onNotice(worktree.removed ? `Worktree ${worktree.name} removed with it` : `Worktree ${worktree.name} kept: ${worktree.reason ?? 'it still has work in it'}`);
    });
  }

  function startNew(kind: SessionKind) {
    setNewMenuOpen(false);
    if (kind === 'claude') onNewClaude?.(); else onNewDevin?.();
  }
  const newKinds: SessionKind[] = [...(onNewClaude ? ['claude' as const] : []), ...(onNewDevin ? ['devin' as const] : [])];

  function menuAt(e: React.MouseEvent, width: number) {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    return { top: r.bottom + 2, left: Math.max(4, Math.min(r.right - width, window.innerWidth - width - 14)) };
  }

  const seg = <T extends string>(value: T, options: ReadonlyArray<readonly [T, string]>, onPick: (v: T) => void) => (
    <div className="sessions-seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onPick(v)}>{label}</button>
      ))}
    </div>
  );

  // One session line. `tabId` is the open tab showing it, if any; `row` is
  // null for a tab not listed yet.
  function renderRow(row: SessionRow | null, opts: { tabId?: string; title?: string; kind?: SessionKind; depth?: number } = {}): ReactNode {
    const key = row ? sessionRowKey(row) : `tab:${opts.tabId}`;
    const tabId = opts.tabId ?? (row ? openTabs?.tabOf.get(key) : undefined);
    const isUnread = row ? unread.has(key) : false;
    const status = row ? sessionStatus(row, isUnread, now) : { tone: 'idle' as const, label: 'Not started' };
    const project = row && scope === 'all' ? projectNames.get(row.projectId) : undefined;
    const editing = row !== null && renaming?.key === key;
    const kind = row?.kind ?? opts.kind ?? 'claude';
    const isActive = tabId ? tabId === workspace?.activeTabId : key === activeKey;
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
        className={`session-row tone-${status.tone}${isActive ? ' active' : ''}${tabId ? ' open' : ''}${row?.archived ? ' archived' : ''}${depth > 0 ? ' child' : ''}`}
        style={depth > 0 ? { paddingLeft: 12 + depth * 18 } : undefined}
        title={`${row?.title ?? opts.title}${tabId ? ' — open in a tab' : ''}`}
        onClick={() => {
          if (editing) return;
          if (tabId && workspace) workspace.onActivateTab(tabId);
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
            {row?.worktree && <span className="session-row-worktree" title={`Works in its own git worktree: .claude/worktrees/${row.worktree}`}> · ⎇ {row.worktree}</span>}
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
          onClick={(e) => setMenu({ row, tabId: tabId ?? null, ...menuAt(e, 200) })}
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
      {subsOpen && groupChildren(children).map((node) => {
        const childRow = (c: typeof children[number], d: number) => renderRow(c.row, { tabId: c.tabId ?? undefined, title: c.title, kind: 'claude', depth: d });
        if (node.kind === 'child') return childRow(node.item, depth + 1);
        // Children the parent's agent opened as one batch.
        const gk = `${key}:${node.label}`;
        const closed = groupsClosed.has(gk);
        const toggle = () => setGroupsClosed((prev) => { const next = new Set(prev); if (next.has(gk)) next.delete(gk); else next.add(gk); return next; });
        return (
          <Fragment key={`g:${gk}`}>
            <div
              className="session-group-row"
              style={{ paddingLeft: 12 + (depth + 1) * 18 }}
              title={`${node.label} — ${node.total} child session${node.total === 1 ? '' : 's'}${node.running > 0 ? `, ${node.running} running` : ', none running'}`}
              onClick={toggle}
            >
              <span className="session-group-caret" aria-hidden="true">{closed ? '▸' : '▾'}</span>
              <span className="session-group-icon" aria-hidden="true">⚙</span>
              <span className="session-group-label">{node.label}</span>
              <span className={`session-row-subagents${node.running > 0 ? ' running' : ''}`}>{node.total - node.running}/{node.total}</span>
            </div>
            {!closed && node.items.map((c) => childRow(c, depth + 2))}
          </Fragment>
        );
      })}
      </Fragment>
    );
  }

  const topLevel = (list: readonly SessionRow[]) => (kids ? list.filter((r) => !kids.childRowKeys.has(sessionRowKey(r))) : list);

  function renderBody(): ReactNode {
    if (error) return <div className="sessions-empty error">{error}</div>;
    if (rows === null) return <div className="sessions-empty">Loading…</div>;
    // Fresh tabs not listed yet (children sit under their parent instead).
    const pending = !filtering && openTabs ? openTabs.pending.filter((p) => !kids?.childTabIds.has(p.tabId)) : [];
    if (shown.length === 0 && pending.length === 0) {
      return (
        <div className="sessions-empty">
          {rows.length === 0 ? 'No sessions yet — start one with ＋'
            : filter.archived ? 'Nothing archived'
            : 'No sessions match'}
        </div>
      );
    }
    return (
      <>
        {pending.map((p) => renderRow(null, { tabId: p.tabId, title: p.title, kind: p.kind }))}
        {topLevel(shown).map((r) => renderRow(r))}
      </>
    );
  }

  return (
    <div className="sessions-view">
      <div className="sessions-head">
        <span className="sessions-title">Sessions</span>
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
      {menu && createPortal(
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
                onNewChild(row, 'plain');
              }}
            >＋ New child session</button>
          )}
          {menu.row?.kind === 'claude' && onNewChild && (
            <button
              className="overflow-action"
              title="Start a new Claude session under this one in its own git worktree and branch (.claude/worktrees/…), so its edits can't collide with other sessions'"
              onClick={() => {
                const row = menu.row!;
                setMenu(null);
                setSubagentsOpen((prev) => new Set(prev).add(sessionRowKey(row)));
                onNewChild(row, 'worktree');
              }}
            >⎇ New child session in a worktree</button>
          )}
          {menu.row?.kind === 'claude' && onNewChild && (
            <button
              className="overflow-action"
              title="Start a child from a compacted copy of this whole conversation, written by this session's model: it keeps far more detail than the short summary a plain child gets, and takes longer to start. This session itself is not compacted."
              onClick={() => {
                const row = menu.row!;
                setMenu(null);
                setSubagentsOpen((prev) => new Set(prev).add(sessionRowKey(row)));
                onNewChild(row, 'compacted');
              }}
            >⧉ New child session with compacted context</button>
          )}
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
          {(() => {
            // Child sessions (any depth) of this one that are running now.
            const row = menu.row;
            if (!row || row.kind !== 'claude' || !kids) return null;
            let live = 0;
            const walk = (id: string, depth: number) => {
              for (const c of kids.childrenOf.get(id) ?? []) {
                if (!c.row) continue;
                if (c.row.live) live++;
                if (depth < 4) walk(c.row.sessionId, depth + 1);
              }
            };
            walk(row.sessionId, 0);
            if (live === 0) return null;
            return (
              <button
                className="overflow-action"
                title="Stops this session and every child session under it. The children do not report back, so nothing is started again."
                onClick={() => { void act('Stop', async () => { await stopSession(row, { withChildren: true }); }); }}
              >■ Stop with {live} child session{live === 1 ? '' : 's'}</button>
            );
          })()}
          {menu.row?.kind === 'claude' && (
            <button className="overflow-action danger" onClick={() => confirmDelete(menu.row!)}>🗑 Delete…</button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
