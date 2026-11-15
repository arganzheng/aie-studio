import { useEffect, useRef, useState } from 'react';
import { browseDirs, type BrowseResult } from '../api';

// Model: web.DirPicker — the "Browse…" dialog of ProjectManager's add form.
// Walks the *server* filesystem via server.BrowseDirs: the browser's native
// folder picker only sees the client machine and never yields a path.
// Single click enters a folder; "Select this folder" returns the current one.
// Escape is routed by the parent (ProjectManager owns a capture-phase key
// handler), so this component does not listen for it itself.
export function DirPicker({ initialPath, onSelect, onClose }: {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [cur, setCur] = useState<BrowseResult | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  async function load(p?: string, fallbackHome = false) {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await browseDirs(p);
      if (my !== seq.current) return;
      setCur(r);
      setPathInput(r.path);
      setError(null);
      listRef.current?.scrollTo(0, 0);
    } catch (e: any) {
      if (my !== seq.current) return;
      if (fallbackHome) { void load(undefined); return; }
      setError(e.message || String(e));
      // Keep the last good listing; put its path back in the box.
      setPathInput((v) => (cur ? cur.path : v));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath?.trim() || undefined, !!initialPath?.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);

  return (
    <div
      className="settings-backdrop dp-backdrop"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <div className="settings-modal dp-modal" role="dialog" aria-label="Choose folder" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Choose folder</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dp-body">
          <div className="dp-pathbar">
            <button
              type="button"
              className="pm-btn icon dp-nav"
              title="Home"
              aria-label="Home"
              disabled={loading}
              onClick={() => void load(undefined)}
            >⌂</button>
            <input
              className="dp-path"
              value={pathInput}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(pathInput);
              }}
              title="Type a path and press Enter to jump"
            />
          </div>
          {error && <div className="dp-error">{error}</div>}
          <div className={`dp-list${loading ? ' loading' : ''}`} ref={listRef}>
            {cur?.parent && (
              <button type="button" className="dp-row dp-up" onClick={() => void load(cur.parent!)}>
                <span className="dp-icon">↑</span><span>..</span>
              </button>
            )}
            {cur?.dirs.map((d) => (
              <button type="button" key={d} className="dp-row" title={join(cur.path, d)} onClick={() => void load(join(cur.path, d))}>
                <span className="dp-icon">📁</span><span className="dp-name">{d}</span>
              </button>
            ))}
            {cur && cur.dirs.length === 0 && <div className="dp-empty">No subfolders</div>}
          </div>
        </div>
        <div className="dp-footer">
          <button type="button" className="pm-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="pm-btn primary"
            disabled={!cur || loading}
            onClick={() => cur && onSelect(cur.path)}
          >Select this folder</button>
        </div>
      </div>
    </div>
  );
}
