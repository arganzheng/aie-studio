import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { archiveSession, deleteSessionForever, listAllSessions, renameAnySession, stopSession } from '../api';
import { useFitMenuTop } from '../lib/fitMenu';
import {
  NO_FILTER, filterSessions, isFiltering, sessionRowKey, sessionStatus,
  type SessionFilter, type SessionKind, type SessionRow,
} from '../lib/sessionList';
import { providerIcon } from './TabBar';

// Model: web.SessionList — the sidebar's Sessions view: every Claude and
// Devin session of this project (or of all projects), newest first, with
// what it is doing right now. Click a row to open or go to the session; the
// ⋯ menu renames, archives, stops and deletes. Fed by server.ListAllSessions,
// refreshed on a timer while visible and whenever `refreshSignal` changes
// (a session event arrived).

const POLL_MS = 5000;
const SCOPE_LS_KEY = 'remote-ide:sessionListScope';

type Scope = 'project' | 'all';

function loadScope(): Scope {
  try { return localStorage.getItem(SCOPE_LS_KEY) === 'all' ? 'all' : 'project'; } catch { return 'project'; }
}

export function SessionList({
  projectId,
  projectNames,
  unread,
  activeKey,
  refreshSignal,
  onOpen,
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
  onOpen: (row: SessionRow) => void;
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
  const [menu, setMenu] = useState<{ row: SessionRow; top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTop = useFitMenuTop(menuRef, menu, menu?.top ?? 0);
  const seq = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(SCOPE_LS_KEY, scope); } catch {}
  }, [scope]);

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
      await deleteSessionForever(row);
      onDeleted(row);
    });
  }

  function startNew(kind: SessionKind) {
    setNewMenuOpen(false);
    if (kind === 'claude') onNewClaude?.(); else onNewDevin?.();
  }
  const newKinds: SessionKind[] = [...(onNewClaude ? ['claude' as const] : []), ...(onNewDevin ? ['devin' as const] : [])];

  const seg = <T extends string>(value: T, options: ReadonlyArray<readonly [T, string]>, onPick: (v: T) => void) => (
    <div className="sessions-seg" role="group">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onPick(v)}>{label}</button>
      ))}
    </div>
  );

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
      <div className="sessions-list">
        {error && <div className="sessions-empty error">{error}</div>}
        {!error && rows === null && <div className="sessions-empty">Loading…</div>}
        {!error && rows !== null && shown.length === 0 && (
          <div className="sessions-empty">
            {rows.length === 0 ? 'No sessions yet — start one with ＋'
              : filter.archived ? 'Nothing archived'
              : 'No sessions match'}
          </div>
        )}
        {shown.map((row) => {
          const key = sessionRowKey(row);
          const isUnread = unread.has(key);
          const status = sessionStatus(row, isUnread, now);
          const project = scope === 'all' ? projectNames.get(row.projectId) : undefined;
          const editing = renaming?.key === key;
          return (
            <div
              key={key}
              className={`session-row tone-${status.tone}${key === activeKey ? ' active' : ''}${row.archived ? ' archived' : ''}`}
              title={row.title}
              onClick={() => { if (!editing) onOpen(row); }}
            >
              <span className="session-row-icon">{providerIcon(row.kind === 'devin' ? 'devin' : 'session')}</span>
              <div className="session-row-main">
                {editing ? (
                  <input
                    autoFocus
                    className="tree-rename"
                    value={renaming.text}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ key, text: e.target.value })}
                    onBlur={() => commitRename(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(row); }
                      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                    }}
                  />
                ) : (
                  <div className="session-row-title">{row.title}</div>
                )}
                <div className="session-row-sub">
                  <span className="session-row-status">{status.label}</span>
                  {project && <span> · {project}</span>}
                </div>
              </div>
              {(status.tone === 'awaiting' || status.tone === 'running' || isUnread) && (
                <span className={`session-row-dot ${status.tone}`} aria-hidden="true" />
              )}
              <button
                type="button"
                className="session-row-menu-btn"
                title="More"
                aria-label="More"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ row, top: r.bottom + 2, left: Math.max(4, Math.min(r.right - 200, window.innerWidth - 214)) });
                }}
              >⋯</button>
            </div>
          );
        })}
      </div>
      {menu && createPortal(
        <div ref={menuRef} className="tab-overflow-menu" style={{ top: menuTop, left: menu.left }}>
          <button className="overflow-action" onClick={() => { const row = menu.row; setMenu(null); onOpen(row); }}>↗ Open</button>
          <button
            className="overflow-action"
            onClick={() => { const row = menu.row; setMenu(null); setRenaming({ key: sessionRowKey(row), text: row.title }); }}
          >✎ Rename</button>
          <button
            className="overflow-action"
            onClick={() => { const row = menu.row; void act(row.archived ? 'Unarchive' : 'Archive', () => archiveSession(row, !row.archived)); }}
          >{menu.row.archived ? '↩ Unarchive' : '🗄 Archive'}</button>
          {menu.row.live && (
            <button
              className="overflow-action"
              onClick={() => { const row = menu.row; void act('Stop', async () => { await stopSession(row); }); }}
            >■ Stop</button>
          )}
          {menu.row.kind === 'claude' && (
            <button className="overflow-action danger" onClick={() => confirmDelete(menu.row)}>🗑 Delete…</button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
