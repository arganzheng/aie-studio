import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, deleteEntry, listDir, makeDir, moveEntry, statFile, uploadFile, type FsEntry, type FsStat } from '../api';
import { copyText } from '../lib/clipboard';
import { joinPath, parentPath, rewriteMovedPath } from '../lib/movedPath';
import { isTextFile } from '../lib/textFiles';
import { useFitMenuTop } from '../lib/fitMenu';

// Model: web.FileTree (auc-009). Lazy tree over server.ListDir; the per-row
// ⋯ menu offers Download (files), Rename, Move to…, Upload here… (dirs) and
// Details — Rename / Move land on server.MoveEntry, Upload on
// server.UploadFile, Details reads server.StatFile.

type Entry = FsEntry;

const POLL_INTERVAL_MS = 3000;
// Use a sentinel for the project root so it slots into the same Set / Map as
// nested directories — keeps the polling loop uniform.
const ROOT_KEY = '';

// rule-076 — "Download" hits ReadFile via a same-origin <a download>; no Tab
// is opened and the drawer stays put.
function triggerDownload(projectId: string, filePath: string) {
  const filename = filePath.split('/').pop() || 'download';
  const a = document.createElement('a');
  a.href = `/api/fs/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function entriesEqual(a: Entry[] | undefined, b: Entry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].isDir !== b[i].isDir) return false;
  }
  return true;
}

type Rename = { path: string; value: string };
// rule-454 — inline "new folder" row under `dir`.
type NewFolder = { dir: string; value: string };

function Node({
  entry,
  depth,
  expanded,
  childrenByPath,
  onToggle,
  onMenu,
  selectedPath,
  rename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  dropTarget,
  onDragOverDir,
  onDropFiles,
  upload,
  newFolder,
  onNewFolderChange,
  onNewFolderCommit,
  onNewFolderCancel,
}: {
  entry: Entry;
  depth: number;
  expanded: Set<string>;
  childrenByPath: Map<string, Entry[]>;
  onToggle: (entry: Entry) => void;
  onMenu: (e: React.MouseEvent, entry: Entry) => void;
  selectedPath: string | null;
  rename: Rename | null;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  // rule-453 — OS file drag onto a directory row; files rows are not targets.
  dropTarget: string | null;
  onDragOverDir: (e: React.DragEvent, dir: string | null) => void;
  onDropFiles: (e: React.DragEvent, dir: string) => void;
  // rule-453 — progress of the upload currently landing in this directory.
  upload: UploadProgress | null;
  newFolder: NewFolder | null;
  onNewFolderChange: (value: string) => void;
  onNewFolderCommit: () => void;
  onNewFolderCancel: () => void;
}) {
  const open = expanded.has(entry.path);
  const kids = open ? childrenByPath.get(entry.path) : undefined;
  const selected = selectedPath === entry.path;
  const renaming = rename?.path === entry.path;
  const isDropTarget = entry.isDir && dropTarget === entry.path;
  const uploading = entry.isDir && upload?.dir === entry.path ? upload : null;
  const creatingHere = entry.isDir && open && newFolder?.dir === entry.path;
  return (
    <>
      <div
        className={`tree-item ${selected ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => { if (!renaming) onToggle(entry); }}
        onDragOver={entry.isDir ? (e) => onDragOverDir(e, entry.path) : undefined}
        onDragLeave={entry.isDir ? (e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) onDragOverDir(e, null);
        } : undefined}
        onDrop={entry.isDir ? (e) => onDropFiles(e, entry.path) : undefined}
      >
        <span className="tree-toggle">{entry.isDir ? (open ? '▾' : '▸') : ' '}</span>
        <span className="tree-icon">{entry.isDir ? '📁' : '📄'}</span>
        {renaming ? (
          // rule-411 — inline rename; Enter commits, Esc / blur cancels.
          <input
            autoFocus
            className="tree-rename"
            value={rename!.value}
            onChange={(e) => onRenameChange(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={onRenameCancel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); }
              if (e.key === 'Escape') { e.preventDefault(); onRenameCancel(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{entry.name}</span>
        )}
        {uploading && !renaming && (
          <span className="tree-upload-status" title={uploading.name}>
            ⬆ {uploading.index}/{uploading.total} {uploading.pct}%
          </span>
        )}
        {!renaming && (
          <button
            className="tree-menu-btn"
            onClick={(e) => onMenu(e, entry)}
            title={entry.isDir ? 'Folder menu' : 'File menu'}
            aria-label={entry.isDir ? 'Folder menu' : 'File menu'}
          >⋯</button>
        )}
      </div>
      {open && (kids || creatingHere) && (
        <div className="tree-children">
          {creatingHere && (
            <div className="tree-item" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
              <span className="tree-toggle"> </span>
              <span className="tree-icon">📁</span>
              <input
                autoFocus
                className="tree-rename"
                placeholder="New folder name"
                value={newFolder!.value}
                onChange={(e) => onNewFolderChange(e.target.value)}
                onBlur={onNewFolderCancel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); onNewFolderCommit(); }
                  if (e.key === 'Escape') { e.preventDefault(); onNewFolderCancel(); }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
          {(kids ?? []).map((c) => (
            <Node
              key={c.path}
              entry={c}
              depth={depth + 1}
              expanded={expanded}
              childrenByPath={childrenByPath}
              onToggle={onToggle}
              onMenu={onMenu}
              selectedPath={selectedPath}
              rename={rename}
              onRenameChange={onRenameChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              dropTarget={dropTarget}
              onDragOverDir={onDragOverDir}
              onDropFiles={onDropFiles}
              upload={upload}
              newFolder={newFolder}
              onNewFolderChange={onNewFolderChange}
              onNewFolderCommit={onNewFolderCommit}
              onNewFolderCancel={onNewFolderCancel}
            />
          ))}
        </div>
      )}
    </>
  );
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

type UploadProgress = { dir: string; index: number; total: number; name: string; pct: number };

// rule-412 — "Move to…" destination chooser: a dirs-only lazy tree with the
// project root pinned on top. The entry being moved (and, for a directory,
// everything under it) is shown but not selectable. "+ New folder" creates a
// directory under the selected one in place (server.MakeDir).
function DirPicker({
  projectId,
  entry,
  onPick,
  onClose,
  onNotice,
}: {
  projectId: string;
  entry: Entry;
  onPick: (destDir: string) => void;
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const currentParent = parentPath(entry.path);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Pre-open the chain down to the entry's current parent so the user
    // starts where the entry lives.
    const s = new Set<string>([ROOT_KEY]);
    let p = currentParent;
    while (p) { s.add(p); p = parentPath(p); }
    return s;
  });
  const [dirs, setDirs] = useState<Map<string, Entry[]>>(new Map());
  const [selected, setSelected] = useState<string>(currentParent);
  // Inline "new folder" input under `selected`; null = not editing.
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    try {
      const items = await listDir(projectId, path);
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(path, items.filter((i) => i.isDir));
        return next;
      });
    } catch {
      // leave the node childless; the user can retry by toggling
    }
  }, [projectId]);

  useEffect(() => {
    for (const p of expanded) if (!dirs.has(p)) load(p);
  }, [expanded, load]);

  const isBlocked = (dir: string) =>
    entry.isDir && (dir === entry.path || dir.startsWith(entry.path + '/'));

  function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  }

  function startNewFolder() {
    setExpanded((prev) => new Set(prev).add(selected));
    setNewFolder('');
  }

  async function commitNewFolder() {
    if (newFolder === null) return;
    const name = newFolder.trim();
    const parent = selected;
    setNewFolder(null);
    if (!name) return;
    if (name.includes('/')) {
      onNotice?.('Name cannot contain "/"');
      return;
    }
    try {
      const res = await makeDir(projectId, joinPath(parent, name));
      await load(parent);
      setExpanded((prev) => new Set(prev).add(parent));
      setSelected(res.path);
    } catch (e) {
      onNotice?.(`New folder failed: ${(e as Error).message}`);
    }
  }

  function renderDir(dir: string, name: string, depth: number) {
    const open = expanded.has(dir);
    const kids = dirs.get(dir);
    const blocked = isBlocked(dir);
    const hasKids = kids === undefined || kids.length > 0;
    return (
      <div key={dir || '/'}>
        <div
          className={`dirpicker-row ${selected === dir ? 'selected' : ''} ${blocked ? 'disabled' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            if (blocked) return;
            setSelected(dir);
            if (!open) toggle(dir);
          }}
        >
          <span
            className="tree-toggle"
            onClick={(e) => { e.stopPropagation(); if (!blocked) toggle(dir); }}
          >{hasKids ? (open ? '▾' : '▸') : ' '}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{name}</span>
        </div>
        {open && !blocked && newFolder !== null && selected === dir && (
          <div className="dirpicker-row" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
            <span className="tree-toggle"> </span>
            <span className="tree-icon">📁</span>
            <input
              autoFocus
              className="tree-rename"
              placeholder="New folder name"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onBlur={() => setNewFolder(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitNewFolder(); }
                if (e.key === 'Escape') { e.preventDefault(); setNewFolder(null); }
              }}
            />
          </div>
        )}
        {open && !blocked && kids && kids.map((k) => renderDir(k.path, k.name, depth + 1))}
      </div>
    );
  }

  const unchanged = selected === currentParent;
  // Portal: the mobile sidebar drawer is transformed, which would otherwise
  // make it the containing block for this fixed backdrop.
  return createPortal(
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal dirpicker-modal"
        role="dialog"
        aria-label="Move to"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span>Move “{entry.name}” to…</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dirpicker-body">
          {renderDir(ROOT_KEY, '/ (project root)', 0)}
        </div>
        <div className="dirpicker-footer">
          <button
            className="dirpicker-newfolder"
            disabled={newFolder !== null || isBlocked(selected)}
            onClick={startNewFolder}
          >+ New folder</button>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={unchanged || isBlocked(selected)}
            onClick={() => onPick(selected)}
          >Move here</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// rule-433 — one row of the Details dialog; `copy` adds a Copy button whose
// label flips to "Copied" for a moment on success.
function DetailRow({
  label,
  value,
  mono,
  copy,
  onNotice,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
  onNotice?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="details-row">
      <div className="details-label">{label}</div>
      <div className={`details-value ${mono ? 'mono' : ''}`} title={value}>{value}</div>
      {copy && (
        <button
          className={`details-copy ${copied ? 'copied' : ''}`}
          onClick={async () => {
            const ok = await copyText(value);
            if (ok) setCopied(true); else onNotice?.('Copy failed');
          }}
        >{copied ? '✓ Copied' : 'Copy'}</button>
      )}
    </div>
  );
}

// rule-433 — "Details" dialog: name / project path / full path with one-click
// copy, plus type, size, mime and mtime from server.StatFile. Name and paths
// never wait on the stat call, so the dialog stays useful if it fails.
function EntryDetails({
  projectId,
  projectPath,
  entry,
  onClose,
  onNotice,
}: {
  projectId: string;
  projectPath: string;
  entry: Entry;
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const [stat, setStat] = useState<FsStat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    statFile(projectId, entry.path)
      .then((s) => { if (!cancelled) setStat(s); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [projectId, entry.path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const root = projectPath.replace(/\/+$/, '');
  const fullPath = `${root}/${entry.path}`;
  const pending = !stat && !error;
  const statText = (f: (s: FsStat) => string) => (stat ? f(stat) : error ? `— (${error})` : '…');

  return createPortal(
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal details-modal"
        role="dialog"
        aria-label="Details"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span>{entry.isDir ? '📁' : '📄'} Details</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="details-body">
          <DetailRow label="Name" value={entry.name} mono copy onNotice={onNotice} />
          <DetailRow label="Project path" value={entry.path} mono copy onNotice={onNotice} />
          <DetailRow label="Full path" value={fullPath} mono copy onNotice={onNotice} />
          <DetailRow label="Type" value={entry.isDir ? 'Folder' : 'File'} />
          {!entry.isDir && (
            <DetailRow
              label="Size"
              value={statText((s) => `${formatBytes(s.size)} (${s.size.toLocaleString()} bytes)`)}
            />
          )}
          {!entry.isDir && (
            <DetailRow label="MIME" value={statText((s) => s.mime)} mono />
          )}
          <DetailRow
            label="Modified"
            value={statText((s) => new Date(s.mtimeMs).toLocaleString())}
          />
          {pending && <div className="details-hint">Loading file info…</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function FileTree({
  projectId,
  projectName,
  projectPath,
  onSelect,
  selectedPath,
  onEntryMoved,
  onEntryDeleted,
  onNotice,
  onEdit,
}: {
  projectId: string;
  // rule-455 — label of the pinned root row.
  projectName: string;
  // Absolute root of the project on the server — rule-433 builds the
  // "Full path" client-side from it.
  projectPath: string;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  // web.EditorPanel entry — "✎ Edit" on text files.
  onEdit?: (path: string) => void;
  // rule-413 — fired after a successful rename / move so the App can rewrite
  // open file Tabs.
  onEntryMoved?: (from: string, to: string) => void;
  // rule-459 — fired after a successful delete so the App can close Tabs
  // that were showing the entry.
  onEntryDeleted?: (path: string) => void;
  onNotice?: (text: string) => void;
}) {
  // Which dirs are visually expanded. Survives polling refreshes because it
  // lives at the top level — Node only reads it. Closing a dir removes it
  // from the set; deletion-from-disk doesn't (next render just won't reach it
  // because the parent's child list no longer contains it).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Cached directory listings. Replaced wholesale per-dir on refresh but only
  // when the contents actually changed (entriesEqual short-circuit), keeping
  // React re-renders tight.
  const [childrenByPath, setChildrenByPath] = useState<Map<string, Entry[]>>(new Map());
  // Mirror of the latest expanded/cache so the polling effect can read them
  // without having `expanded` in its dep array (which would tear down/rebuild
  // the interval on every toggle).
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(childrenByPath);
  expandedRef.current = expanded;
  cacheRef.current = childrenByPath;
  // Per-row ⋯ overflow menu (one open at a time); closes on outside press.
  const [menu, setMenu] = useState<{ entry: Entry; top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTop = useFitMenuTop(menuRef, menu, menu?.top ?? 0);
  const [rename, setRename] = useState<Rename | null>(null);
  const [moving, setMoving] = useState<Entry | null>(null);
  const [details, setDetails] = useState<Entry | null>(null);
  // rule-453 — upload: hidden file input, the dir it will land in, the
  // sequential progress readout, and the dir currently hovered by a drag.
  // Only directories are targets; the project root is the pinned root row
  // (rule-455) whose path is ROOT_KEY.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDirRef = useRef<string>('');
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<NewFolder | null>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menu]);

  const openMenu = useCallback((e: React.MouseEvent, entry: Entry) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      entry,
      top: r.bottom + 2,
      left: Math.max(4, Math.min(r.left, window.innerWidth - 244)),
    });
  }, []);

  const fetchDir = useCallback(async (path: string) => {
    try {
      const items = await listDir(projectId, path);
      setChildrenByPath((prev) => {
        if (entriesEqual(prev.get(path), items)) return prev;
        const next = new Map(prev);
        next.set(path, items);
        return next;
      });
    } catch {
      // network blips during polling are silently ignored — next tick retries
    }
  }, [projectId]);

  // Initial load when projectId changes. Drop caches so we don't show stale
  // entries from the previous project briefly while the new ones fetch.
  useEffect(() => {
    setExpanded(new Set());
    setChildrenByPath(new Map());
    setMenu(null);
    setRename(null);
    setMoving(null);
    setNewFolder(null);
    fetchDir(ROOT_KEY);
  }, [projectId, fetchDir]);

  // Poll: every interval, re-fetch root + every currently-expanded dir.
  // Skipped while the tab is hidden so we don't spam the server in background
  // tabs.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      const paths = new Set<string>([ROOT_KEY, ...expandedRef.current]);
      await Promise.all([...paths].map((p) => fetchDir(p)));
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [fetchDir]);

  const handleToggle = useCallback((entry: Entry) => {
    if (!entry.isDir) {
      onSelect(entry.path);
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!cacheRef.current.has(entry.path)) {
          // Fire off the first fetch immediately — async update lands when
          // the response arrives. Polling will keep it fresh thereafter.
          fetchDir(entry.path);
        }
      }
      return next;
    });
  }, [onSelect, fetchDir]);

  // rule-413 — shared tail of Rename and Move: call MoveEntry, refresh both
  // parents right away, carry expanded state along, and tell the App.
  const doMove = useCallback(async (from: string, to: string) => {
    if (from === to) return;
    try {
      const res = await moveEntry(projectId, from, to);
      setExpanded((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          const np = rewriteMovedPath(p, res.from, res.to);
          if (np === null) next.add(p); else { next.add(np); changed = true; }
        }
        return changed ? next : prev;
      });
      const refresh = new Set<string>([parentPath(res.from), parentPath(res.to)]);
      for (const p of expandedRef.current) {
        const np = rewriteMovedPath(p, res.from, res.to);
        if (np !== null) refresh.add(np);
      }
      await Promise.all([...refresh].map((p) => fetchDir(p)));
      onEntryMoved?.(res.from, res.to);
    } catch (e) {
      onNotice?.(`Move failed: ${(e as Error).message}`);
    }
  }, [projectId, fetchDir, onEntryMoved, onNotice]);

  // rule-411 — commit only when the name actually changed and is a plain
  // basename.
  const commitRename = useCallback(() => {
    if (!rename) return;
    const name = rename.value.trim();
    const oldName = rename.path.split('/').pop() ?? '';
    setRename(null);
    if (!name || name === oldName) return;
    if (name.includes('/')) {
      onNotice?.('Name cannot contain "/"');
      return;
    }
    void doMove(rename.path, joinPath(parentPath(rename.path), name));
  }, [rename, doMove, onNotice]);

  // rule-453 — sequential upload of the chosen files into `dir`; 409 asks
  // before overwriting, every other failure is a toast and we move on.
  const uploadFiles = useCallback(async (dir: string, files: File[]) => {
    if (files.length === 0) return;
    const total = files.length;
    for (let i = 0; i < total; i++) {
      const file = files[i];
      const report = (sent: number, size: number) =>
        setUpload({ dir, index: i + 1, total, name: file.name, pct: size > 0 ? Math.round((sent / size) * 100) : 0 });
      report(0, file.size);
      try {
        try {
          await uploadFile(projectId, dir, file, { onProgress: report });
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409) throw e;
          if (!window.confirm(`"${file.name}" already exists. Overwrite?`)) continue;
          await uploadFile(projectId, dir, file, { overwrite: true, onProgress: report });
        }
      } catch (e) {
        onNotice?.(`Upload "${file.name}" failed: ${(e as Error).message}`);
      }
    }
    setUpload(null);
    // Show the result right away rather than waiting for the next poll.
    if (dir !== ROOT_KEY) setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)));
    await fetchDir(dir);
  }, [projectId, fetchDir, onNotice]);

  // rule-454 — open the dir and show the inline input as its first row.
  const startNewFolder = useCallback((dir: string) => {
    if (dir !== ROOT_KEY) setExpanded((prev) => {
      if (prev.has(dir)) return prev;
      if (!cacheRef.current.has(dir)) fetchDir(dir);
      return new Set(prev).add(dir);
    });
    setNewFolder({ dir, value: '' });
  }, [fetchDir]);

  const commitNewFolder = useCallback(async () => {
    if (!newFolder) return;
    const name = newFolder.value.trim();
    const dir = newFolder.dir;
    setNewFolder(null);
    if (!name) return;
    if (name.includes('/')) {
      onNotice?.('Name cannot contain "/"');
      return;
    }
    try {
      await makeDir(projectId, joinPath(dir, name));
      await fetchDir(dir);
    } catch (e) {
      onNotice?.(`New folder failed: ${(e as Error).message}`);
    }
  }, [newFolder, projectId, fetchDir, onNotice]);

  // rule-459 — confirm, DeleteEntry, refresh the parent, tell the App. A
  // non-empty directory is refused by the server (409) and surfaces as a toast.
  const doDelete = useCallback(async (entry: Entry) => {
    if (!window.confirm(`Delete "${entry.name}"?`)) return;
    try {
      const res = await deleteEntry(projectId, entry.path);
      setExpanded((prev) => {
        if (!prev.has(res.path)) return prev;
        const next = new Set(prev);
        next.delete(res.path);
        return next;
      });
      await fetchDir(parentPath(res.path));
      onEntryDeleted?.(res.path);
    } catch (e) {
      onNotice?.(`Delete failed: ${(e as Error).message}`);
    }
  }, [projectId, fetchDir, onEntryDeleted, onNotice]);

  const pickFiles = useCallback((dir: string) => {
    uploadDirRef.current = dir;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  }, []);

  // `dir === null` is the dragleave signal: clear the highlight.
  const onDragOverDir = useCallback((e: React.DragEvent, dir: string | null) => {
    if (!hasFiles(e)) return;
    if (dir === null) { setDropTarget(null); return; }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropTarget((prev) => (prev === dir ? prev : dir));
  }, []);

  const onDropFiles = useCallback((e: React.DragEvent, dir: string) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    void uploadFiles(dir, Array.from(e.dataTransfer.files));
  }, [uploadFiles]);

  const rootItems = useMemo(() => childrenByPath.get(ROOT_KEY) ?? [], [childrenByPath]);
  // rule-455 — synthetic entry so the root row shares the ⋯ menu machinery.
  const rootEntry = useMemo<Entry>(() => ({ name: projectName, path: ROOT_KEY, isDir: true }), [projectName]);
  const rootUploading = upload?.dir === ROOT_KEY ? upload : null;

  return (
    <div className="tree">
      {/* rule-453 — hidden picker shared by every "⬆ Upload here…" entry */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void uploadFiles(uploadDirRef.current, files);
        }}
      />
      {/* rule-455 — pinned root row: not collapsible, same ⋯ menu as a dir */}
      <div
        className={`tree-item tree-root ${dropTarget === ROOT_KEY ? 'drop-target' : ''}`}
        onDragOver={(e) => onDragOverDir(e, ROOT_KEY)}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) onDragOverDir(e, null);
        }}
        onDrop={(e) => onDropFiles(e, ROOT_KEY)}
      >
        <span className="tree-icon">📁</span>
        <span className="tree-name" title={projectPath}>{projectName}</span>
        {rootUploading && (
          <span className="tree-upload-status" title={rootUploading.name}>
            ⬆ {rootUploading.index}/{rootUploading.total} {rootUploading.pct}%
          </span>
        )}
        <button
          className="tree-menu-btn"
          onClick={(e) => openMenu(e, rootEntry)}
          title="Project root menu"
          aria-label="Project root menu"
        >⋯</button>
      </div>
      {newFolder?.dir === ROOT_KEY && (
        <div className="tree-item" style={{ paddingLeft: 8 }}>
          <span className="tree-toggle"> </span>
          <span className="tree-icon">📁</span>
          <input
            autoFocus
            className="tree-rename"
            placeholder="New folder name"
            value={newFolder.value}
            onChange={(e) => setNewFolder((n) => (n ? { ...n, value: e.target.value } : n))}
            onBlur={() => setNewFolder(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitNewFolder(); }
              if (e.key === 'Escape') { e.preventDefault(); setNewFolder(null); }
            }}
          />
        </div>
      )}
      {rootItems.map((e) => (
        <Node
          key={e.path}
          entry={e}
          depth={0}
          expanded={expanded}
          childrenByPath={childrenByPath}
          onToggle={handleToggle}
          onMenu={openMenu}
          selectedPath={selectedPath}
          rename={rename}
          onRenameChange={(value) => setRename((r) => (r ? { ...r, value } : r))}
          onRenameCommit={commitRename}
          onRenameCancel={() => setRename(null)}
          dropTarget={dropTarget}
          onDragOverDir={onDragOverDir}
          onDropFiles={onDropFiles}
          upload={upload}
          newFolder={newFolder}
          onNewFolderChange={(value) => setNewFolder((n) => (n ? { ...n, value } : n))}
          onNewFolderCommit={() => { void commitNewFolder(); }}
          onNewFolderCancel={() => setNewFolder(null)}
        />
      ))}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="tab-overflow-menu"
          style={{ top: menuTop, left: menu.left }}
        >
          {!menu.entry.isDir && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); triggerDownload(projectId, menu.entry.path); }}
            >⬇ Download</button>
          )}
          {!menu.entry.isDir && onEdit && isTextFile(menu.entry.mime, menu.entry.name) && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); onEdit(menu.entry.path); }}
            >✎ Edit</button>
          )}
          {menu.entry.path !== ROOT_KEY && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); setRename({ path: menu.entry.path, value: menu.entry.name }); }}
            >✎ Rename</button>
          )}
          {menu.entry.path !== ROOT_KEY && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); setMoving(menu.entry); }}
            >📂 Move to…</button>
          )}
          {menu.entry.isDir && (
            <button
              className="overflow-action"
              onClick={() => { const dir = menu.entry.path; setMenu(null); startNewFolder(dir); }}
            >📁 New folder…</button>
          )}
          {menu.entry.isDir && (
            <button
              className="overflow-action"
              disabled={upload !== null}
              onClick={() => { const dir = menu.entry.path; setMenu(null); pickFiles(dir); }}
            >⬆ Upload here…</button>
          )}
          {menu.entry.path !== ROOT_KEY && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); setDetails(menu.entry); }}
            >ℹ Details</button>
          )}
          {menu.entry.path !== ROOT_KEY && (
            <button
              className="overflow-action danger"
              onClick={() => { const entry = menu.entry; setMenu(null); void doDelete(entry); }}
            >🗑 Delete</button>
          )}
        </div>,
        document.body,
      )}
      {moving && (
        <DirPicker
          projectId={projectId}
          entry={moving}
          onClose={() => setMoving(null)}
          onNotice={onNotice}
          onPick={(destDir) => {
            const entry = moving;
            setMoving(null);
            void doMove(entry.path, joinPath(destDir, entry.name));
          }}
        />
      )}
      {details && (
        <EntryDetails
          projectId={projectId}
          projectPath={projectPath}
          entry={details}
          onClose={() => setDetails(null)}
          onNotice={onNotice}
        />
      )}
    </div>
  );
}
