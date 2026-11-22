import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../types';
import { terminalReconnectDelay, TERMINAL_KEYS } from '../lib/terminal';
import { openDuplex, type DuplexSocket } from '../lib/duplex';

// Model: web.TerminalPanel. xterm.js over the `terminal` duplex channel
// (server.TerminalBridge), as a side panel tab. The shell lives on the server
// keyed by this tab's id, so switching tabs, remounting or reloading
// reattaches to the same shell and gets its recent output back. Closing the
// tab ends it (the side panel calls DELETE /api/terminal/<tab>).

type Status = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'error';

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function xtermTheme(theme: Theme): ITheme {
  const light = theme === 'light';
  return {
    background: cssVar('--bg', light ? '#ffffff' : '#1e1e1e'),
    foreground: cssVar('--fg', light ? '#24292f' : '#d4d4d4'),
    cursor: cssVar('--accent', light ? '#0969da' : '#4ec9b0'),
    selectionBackground: light ? '#0969da33' : '#264f78',
    ...(light
      ? { black: '#24292f', brightBlack: '#57606a', white: '#6e7781', brightWhite: '#8c959f', yellow: '#9a6700', brightYellow: '#7d4e00' }
      : {}),
  };
}

const OPEN = 1;

export function TerminalPanel({ projectId, tabId, theme }: { projectId: string; tabId: string; theme: Theme }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<DuplexSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const statusRef = useRef<Status>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [touch] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);

  function sendInput(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  }

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: touch ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: xtermTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    termRef.current = term;

    let disposed = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    const setSt = (s: Status) => { statusRef.current = s; setStatus(s); };

    // Hidden tabs (display:none) measure 0×0 — skip until visible again.
    const fitIfVisible = () => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return false;
      try { fit.fit(); } catch { return false; }
      return true;
    };

    function connect() {
      if (disposed) return;
      fitIfVisible();
      const params = new URLSearchParams({ project: projectId, tab: tabId, cols: String(term.cols), rows: String(term.rows) });
      const ws = openDuplex('terminal', params);
      wsRef.current = ws;
      let started = false;
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'started') {
          started = true;
          attempt = 0;
          setError(null);
          // The server replays its scrollback next; start from a clean screen
          // so a reattach doesn't print everything twice.
          if (m.reattached) term.reset();
          setSt('live');
        } else if (m.type === 'output') {
          term.write(m.data);
        } else if (m.type === 'exit') {
          setSt('exited');
          term.write(`\r\n\x1b[2m[shell exited${m.code ? ` with code ${m.code}` : ''} — press Enter to start a new one]\x1b[0m\r\n`);
        } else if (m.type === 'error') {
          setError(String(m.message ?? 'terminal error'));
          setSt('error');
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (disposed || statusRef.current === 'exited' || statusRef.current === 'error') return;
        if (!started && attempt >= 5) { setError('Could not reach the terminal — refresh the tab (↻) to retry.'); setSt('error'); return; }
        setSt('reconnecting');
        reconnectTimer = window.setTimeout(connect, terminalReconnectDelay(attempt++));
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    const onData = term.onData((data) => {
      if (statusRef.current === 'exited') {
        if (data === '\r') { term.reset(); setSt('connecting'); connect(); }
        return;
      }
      sendInput(data);
    });
    const onResize = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // Refit on layout changes; also the moment a hidden tab becomes visible.
    let wasVisible = false;
    const ro = new ResizeObserver(() => {
      const visible = fitIfVisible();
      if (visible && !wasVisible) term.focus();
      wasVisible = visible;
    });
    ro.observe(host);

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tabId]);

  // CSS variables flip with data-theme; read them after that has happened.
  useEffect(() => {
    const id = requestAnimationFrame(() => { if (termRef.current) termRef.current.options.theme = xtermTheme(theme); });
    return () => cancelAnimationFrame(id);
  }, [theme]);

  return (
    <div className="terminal-panel">
      {status !== 'live' && status !== 'exited' && (
        <div className={`terminal-status terminal-status-${status}`}>
          {status === 'connecting' && 'Starting shell…'}
          {status === 'reconnecting' && 'Reconnecting…'}
          {status === 'error' && (error ?? 'Terminal error')}
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
      {touch && (
        <div className="terminal-keys">
          {TERMINAL_KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className="terminal-key"
              // Keep focus (and the soft keyboard) on the terminal.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { sendInput(k.seq); termRef.current?.focus(); }}
            >{k.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
