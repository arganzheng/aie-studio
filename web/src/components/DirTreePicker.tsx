import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Model: web.DirTreePicker — the one folder chooser: a dirs-only lazy tree
// with its root pinned on top. Where the folders come from is the caller's
// business (`list` / `mkdir`): the FileTree's "Move to…" walks a project
// (server.ListDir / server.MakeDir), the ProjectManager's "Browse…" walks the
// server filesystem (server.BrowseDirs / server.BrowseMakeDir). Paths are
// opaque keys here — project-relative for one, absolute for the other.
export type DirNode = { path: string; name: string };

export function DirTreePicker({
  title,
  ariaLabel,
  root,
  rootLabel,
  onRootUp,
  list,
  mkdir,
  initialSelected,
  initialExpanded,
  isBlocked = () => false,
  canConfirm = () => true,
  confirmLabel,
  describe,
  onPick,
  onClose,
  onNotice,
}: {
  title: string;
  ariaLabel: string;
  root: string;
  rootLabel: string;
  // Shows "↑" on the root row: re-root the tree one level up. The caller
  // remounts the picker (key = root) with the new root.
  onRootUp?: () => void;
  // Subfolders of `path`.
  list: (path: string) => Promise<DirNode[]>;
  // "+ New folder" under the selected one; resolves to the new folder's path.
  // Omit to hide the button.
  mkdir?: (parent: string, name: string) => Promise<string>;
  initialSelected: string;
  // Folders open from the start (the chain down to the initial selection).
  initialExpanded: readonly string[];
  // Shown but not selectable, children hidden (a folder can't move into itself).
  isBlocked?: (dir: string) => boolean;
  canConfirm?: (selected: string) => boolean;
  confirmLabel: string;
  // A line above the buttons spelling out the selection (the absolute path).
  describe?: (selected: string) => string;
  onPick: (dir: string) => void;
  onClose: () => void;
  // Where failures go; without it they show inline above the buttons.
  onNotice?: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root, ...initialExpanded]));
  const [dirs, setDirs] = useState<Map<string, DirNode[]>>(new Map());
  const [selected, setSelected] = useState<string>(initialSelected);
  // Inline "new folder" input under `selected`; null = not editing.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  function notice(text: string) {
    if (onNotice) onNotice(text);
    else setError(text);
  }

  async function load(path: string) {
    try {
      const items = await list(path);
      setDirs((prev) => new Map(prev).set(path, items));
    } catch {
      // leave the node childless; the user can retry by toggling
    }
  }

  useEffect(() => {
    for (const p of expanded) if (!dirs.has(p)) void load(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // Start with the initial selection in view (it can sit deep in the tree).
  const revealedRef = useRef(false);
  useEffect(() => {
    if (revealedRef.current) return;
    const row = bodyRef.current?.querySelector('.dirpicker-row.selected');
    if (!row) return;
    revealedRef.current = true;
    row.scrollIntoView({ block: 'center' });
  }, [dirs]);

  function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  }

  function startNewFolder() {
    setError(null);
    setExpanded((prev) => new Set(prev).add(selected));
    setNewFolder('');
  }

  async function commitNewFolder() {
    if (newFolder === null || !mkdir) return;
    const name = newFolder.trim();
    const parent = selected;
    setNewFolder(null);
    if (!name) return;
    if (name.includes('/')) {
      notice('Name cannot contain "/"');
      return;
    }
    try {
      const created = await mkdir(parent, name);
      await load(parent);
      setExpanded((prev) => new Set(prev).add(parent));
      setSelected(created);
    } catch (e) {
      notice(`New folder failed: ${(e as Error).message}`);
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
            setError(null);
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
          {dir === root && onRootUp && (
            <button
              type="button"
              className="dirpicker-up"
              title="Show the parent folder"
              aria-label="Show the parent folder"
              onClick={(e) => { e.stopPropagation(); onRootUp(); }}
            >↑</button>
          )}
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
                // stopPropagation: Escape here cancels the name, not the dialog.
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNewFolder(null); }
              }}
            />
          </div>
        )}
        {open && !blocked && kids && kids.map((k) => renderDir(k.path, k.name, depth + 1))}
      </div>
    );
  }

  // Portal: the mobile sidebar drawer is transformed, which would otherwise
  // make it the containing block for this fixed backdrop.
  return createPortal(
    <div className="settings-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="settings-modal dirpicker-modal"
        role="dialog"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span>{title}</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dirpicker-body" ref={bodyRef}>
          {renderDir(root, rootLabel, 0)}
        </div>
        {describe && <div className="dirpicker-selected" title={describe(selected)}>{describe(selected)}</div>}
        {error && <div className="dirpicker-error">{error}</div>}
        <div className="dirpicker-footer">
          {mkdir && (
            <button
              className="dirpicker-newfolder"
              disabled={newFolder !== null || isBlocked(selected)}
              onClick={startNewFolder}
            >+ New folder</button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!canConfirm(selected) || isBlocked(selected)}
            onClick={() => onPick(selected)}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
