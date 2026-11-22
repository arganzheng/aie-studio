import { useCallback, useEffect, useRef, useState } from 'react';

// Model: web.PreviewView — a side panel tab showing a dev server running on
// this machine (by port), through aie-studio's own address and login
// (server/src/preview.ts). It opens the server's boot page first, which sets
// up the service worker that keeps the app's requests under
// /preview/<port>/. The address bar shows and takes the app's own path.

export function previewUrl(port: number, path: string): string {
  return `/preview/${port}/__aie/boot?to=${encodeURIComponent(path.startsWith('/') ? path : `/${path}`)}`;
}

// The app's path in the frame: with the /preview/<port> prefix taken off
// (the injected script normally has already).
export function appPath(port: number, pathname: string, search = '', hash = ''): string {
  const p = `/preview/${port}`;
  const rest = pathname === p || pathname.startsWith(`${p}/`) ? pathname.slice(p.length) || '/' : pathname;
  return rest.startsWith('/__aie/') ? '/' : rest + search + hash;
}

export function PreviewView({ port, path, onPath }: {
  port: number;
  path: string;
  // The frame went somewhere else: remember it for next time.
  onPath: (path: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState(() => previewUrl(port, path));
  const [addr, setAddr] = useState(path);
  const [editing, setEditing] = useState(false);
  const lastPath = useRef(path);

  const go = useCallback((to: string) => {
    const p = to.trim() || '/';
    const want = p.startsWith('/') ? p : `/${p}`;
    // A fresh query makes the same address load again.
    setSrc(`${previewUrl(port, want)}&r=${Date.now().toString(36)}`);
    setAddr(want);
  }, [port]);

  // Where the app is now: read from the frame (same origin) once a second.
  useEffect(() => {
    const t = window.setInterval(() => {
      try {
        const l = frameRef.current?.contentWindow?.location;
        if (!l || l.href === 'about:blank') return;
        const now = appPath(port, l.pathname, l.search, l.hash);
        if (now !== lastPath.current) {
          lastPath.current = now;
          if (!editing) setAddr(now);
          onPath(now);
        }
      } catch { /* the app went to another origin */ }
    }, 1000);
    return () => window.clearInterval(t);
  }, [port, editing, onPath]);

  const back = () => { try { frameRef.current?.contentWindow?.history.back(); } catch {} };
  const forward = () => { try { frameRef.current?.contentWindow?.history.forward(); } catch {} };

  return (
    <div className="preview">
      <div className="preview-bar">
        <button type="button" onClick={back} title="Back" aria-label="Back">←</button>
        <button type="button" onClick={forward} title="Forward" aria-label="Forward">→</button>
        <button type="button" onClick={() => go(lastPath.current)} title="Reload" aria-label="Reload">⟳</button>
        <span className="preview-port" title={`The app on port ${port} of this machine, through aie-studio`}>:{port}</span>
        <input
          className="preview-addr"
          value={addr}
          spellCheck={false}
          aria-label="Path in the app"
          onFocus={() => setEditing(true)}
          onBlur={() => { setEditing(false); setAddr(lastPath.current); }}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); go(addr); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          }}
        />
        <a className="preview-open" href={previewUrl(port, lastPath.current)} target="_blank" rel="noreferrer" title="Open in a new window" aria-label="Open in a new window">↗</a>
      </div>
      <iframe
        ref={frameRef}
        key={src}
        className="preview-frame"
        name={`aie-preview:${port}`}
        src={src}
        title={`Preview of port ${port}`}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
