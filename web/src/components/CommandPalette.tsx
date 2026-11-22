import { useEffect, useMemo, useRef, useState } from 'react';
import { listAllSessions } from '../api';
import { ago, search, type PaletteItem } from '../lib/palette';
import type { SessionRow } from '../lib/sessionList';
import type { Project } from '../types';

// Model: web.CommandPalette — Cmd/Ctrl+K (or the 🔍 in the tab bar): search
// every session of every project, archived ones included, plus the projects
// and a few actions. ↑ ↓ to move, Enter to open, Esc to close.

export type PaletteAction = { id: string; title: string; detail?: string; run: () => void };

function sessionDetail(r: SessionRow, project: string, now: number): string {
  const parts = [project, r.kind === 'devin' ? 'Devin' : 'Claude', ago(r.updatedAt, now)];
  if (r.state === 'running') parts.push('working');
  else if (r.state === 'awaiting') parts.push('waiting for you');
  if (r.status) parts.push(r.status.label);
  if (r.worktree) parts.push(`worktree ${r.worktree}`);
  if (r.archived) parts.push('archived');
  return parts.join(' · ');
}

export function CommandPalette({ projects, actions, onOpenSession, onOpenProject, onClose }: {
  projects: Project[];
  actions: PaletteAction[];
  onOpenSession: (row: SessionRow) => void;
  onOpenProject: (projectId: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let off = false;
    listAllSessions('all').then((r) => { if (!off) setRows(r); }, (e) => { if (!off) setError(String(e?.message ?? e)); });
    return () => { off = true; };
  }, []);

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rowById = useMemo(() => new Map((rows ?? []).map((r) => [`s:${r.kind}:${r.sessionId}`, r])), [rows]);
  const items: PaletteItem[] = useMemo(() => {
    const now = Date.now();
    return [
      ...actions.map((a): PaletteItem => ({ id: `a:${a.id}`, group: 'Actions', title: a.title, detail: a.detail ?? '' })),
      ...projects.filter((p) => !p.archived).map((p): PaletteItem => ({ id: `p:${p.id}`, group: 'Projects', title: p.name, detail: p.path })),
      ...(rows ?? []).map((r): PaletteItem => ({
        id: `s:${r.kind}:${r.sessionId}`,
        group: 'Sessions',
        title: r.title || r.sessionId.slice(0, 8),
        detail: sessionDetail(r, byId.get(r.projectId)?.name ?? '?', now),
        words: `${r.sessionId} ${r.kind}`,
        updatedAt: r.updatedAt,
      })),
    ];
  }, [actions, projects, rows, byId]);

  const shown = useMemo(() => search(items, q), [items, q]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.group === 'Actions') actions.find((a) => `a:${a.id}` === item.id)?.run();
    else if (item.group === 'Projects') onOpenProject(item.id.slice(2));
    else { const r = rowById.get(item.id); if (r) onOpenSession(r); }
  };

  let lastGroup: string | null = null;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Search sessions, projects and actions">
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          placeholder="Search sessions, projects and actions"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(shown.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(shown[sel]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {shown.map((item, i) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {head && <div className="palette-group">{head}</div>}
                <div
                  className={`palette-item${i === sel ? ' active' : ''}`}
                  onMouseMove={() => setSel(i)}
                  onClick={() => pick(item)}
                >
                  <div className="palette-title">{item.title}</div>
                  {item.detail && <div className="palette-detail">{item.detail}</div>}
                </div>
              </div>
            );
          })}
          {rows === null && !error && <div className="palette-empty">Loading sessions…</div>}
          {error && <div className="palette-empty">Could not load sessions: {error}</div>}
          {rows !== null && shown.length === 0 && <div className="palette-empty">Nothing matches.</div>}
        </div>
        <div className="palette-foot">↑↓ move · Enter open · Esc close · ⌥J / ⌥K next / previous tab</div>
      </div>
    </div>
  );
}
