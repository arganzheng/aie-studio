import { useCallback, useEffect, useRef, useState } from 'react';
import { openDuplex, type DuplexSocket } from '../lib/duplex';
import type { Theme } from '../types';
import { MarkdownText } from './SdkPanel';

// Model: SideChat (/btw) — a side panel tab for questions about a Claude
// session without interrupting it (server/src/side-chat.ts): a read-only
// fork of the session's conversation that is never saved. Type `/btw …` in
// the session, or pick "Side chat" from "+". Questions asked before the fork
// is up wait and go out in order.

type Line = { role: 'user' | 'assistant' | 'tool' | 'note'; text: string };

// What each side chat showed, kept for this browser tab (sessionStorage):
// the panel can be remounted or the page reloaded, and the lines should not
// vanish with it. The side chat's own memory does not survive that.
const shownKey = (sessionId: string) => `remote-ide:btw:${sessionId}`;
const shown = {
  get(sessionId: string): Line[] {
    try { const v = JSON.parse(sessionStorage.getItem(shownKey(sessionId)) || '[]'); return Array.isArray(v) ? v.slice(-200) : []; } catch { return []; }
  },
  set(sessionId: string, lines: Line[]) {
    try { sessionStorage.setItem(shownKey(sessionId), JSON.stringify(lines.slice(-200))); } catch {}
  },
};

export function SideChat({ projectId, sessionId, label, theme, ask, onClose }: {
  projectId: string;
  sessionId: string;
  label: string;
  theme: Theme;
  // A question sent from the session (`/btw …`); seq makes repeats distinct.
  ask: { question: string; seq: number } | null;
  onClose?: () => void;
}) {
  const [lines, setLines] = useState<Line[]>(() => {
    const before = shown.get(sessionId).filter((l) => !l.text.startsWith('Reconnected:'));
    return before.length ? [...before, { role: 'note', text: 'Reconnected: a fresh copy of the session — it does not remember the side questions above.' }] : [];
  });
  useEffect(() => { shown.set(sessionId, lines); }, [sessionId, lines]);
  const [stream, setStream] = useState('');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'thinking' | 'closed'>('connecting');
  const [text, setText] = useState('');
  const [cost, setCost] = useState(0);
  const wsRef = useRef<DuplexSocket | null>(null);
  const waiting = useRef<string[]>([]);
  const lastAsk = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const sendNow = useCallback((q: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) { waiting.current.push(q); return; }
    ws.send(JSON.stringify({ type: 'ask', text: q }));
    setStatus('thinking');
  }, []);
  const ask1 = useCallback((q: string) => {
    const t = q.trim();
    if (!t) return;
    setLines((l) => [...l, { role: 'user', text: t }]);
    sendNow(t);
  }, [sendNow]);

  const connect = useCallback(() => {
    setStatus('connecting');
    const ws = openDuplex('side-chat', new URLSearchParams({ project: projectId, session: sessionId }));
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('ready');
      for (const q of waiting.current.splice(0)) { ws.send(JSON.stringify({ type: 'ask', text: q })); setStatus('thinking'); }
    };
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'delta') setStream((s) => s + String(m.text ?? ''));
      else if (m.type === 'assistant') {
        setStream('');
        setLines((l) => [
          ...l,
          ...(m.text ? [{ role: 'assistant' as const, text: String(m.text) }] : []),
          ...((m.tools ?? []) as string[]).map((t) => ({ role: 'tool' as const, text: t })),
        ]);
      } else if (m.type === 'done') {
        setStream('');
        setStatus('ready');
        if (typeof m.costUsd === 'number') setCost(m.costUsd);
        if (!m.ok && m.error && m.error !== 'error_during_execution') setLines((l) => [...l, { role: 'note', text: `Stopped: ${m.error}` }]);
      } else if (m.type === 'error') setLines((l) => [...l, { role: 'note', text: String(m.message ?? 'error') }]);
      else if (m.type === 'exit') setStatus('closed');
    };
    ws.onclose = () => { if (wsRef.current === ws) setStatus('closed'); };
  }, [projectId, sessionId]);

  useEffect(() => {
    connect();
    return () => { const ws = wsRef.current; wsRef.current = null; try { ws?.close(); } catch {} };
  }, [connect]);

  useEffect(() => {
    if (!ask || ask.seq === lastAsk.current) return;
    lastAsk.current = ask.seq;
    ask1(ask.question);
  }, [ask, ask1]);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [lines, stream]);

  const restart = () => {
    try { wsRef.current?.close(); } catch {}
    setLines((l) => [...l, { role: 'note', text: 'Started again from the session as it is now — earlier side questions are not part of it.' }]);
    connect();
  };

  return (
    <div className="btw">
      <div className="btw-head" title="A read-only copy of the session's conversation: it can read files but not change anything, and is not saved. The session itself keeps working.">
        <span className="btw-mark">btw</span>
        <span className="btw-label">about <b>{label}</b> · read-only, not saved{cost > 0 ? ` · $${cost.toFixed(3)}` : ''}</span>
        {onClose && <button type="button" className="btw-close" onClick={onClose} aria-label="Close side chat">×</button>}
      </div>
      <div className="btw-body" ref={bodyRef}>
        {lines.length === 0 && !stream && (
          <div className="btw-empty">Ask anything about this session — why it did something, what a file it read says, what is left — without interrupting it.</div>
        )}
        {lines.map((l, i) => (
          l.role === 'user' ? <div key={i} className="btw-q">{l.text}</div>
            : l.role === 'tool' ? <div key={i} className="btw-tool">↳ {l.text}</div>
            : l.role === 'note' ? <div key={i} className="btw-note">{l.text}</div>
            : <div key={i} className="btw-a"><MarkdownText text={l.text} theme={theme} /></div>
        ))}
        {stream && <div className="btw-a"><MarkdownText text={stream} theme={theme} /></div>}
        {status === 'thinking' && !stream && <div className="btw-note">Thinking…</div>}
        {status === 'connecting' && <div className="btw-note">Opening a copy of the session…</div>}
        {status === 'closed' && <div className="btw-note">The side chat ended. <button type="button" onClick={restart}>Start again</button></div>}
      </div>
      <form className="btw-input" onSubmit={(e) => { e.preventDefault(); if (status === 'closed') return; ask1(text); setText(''); }}>
        <textarea
          value={text}
          rows={2}
          placeholder="Ask a side question…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (status !== 'closed') { ask1(text); setText(''); } }
          }}
        />
        {status === 'thinking'
          ? <button type="button" onClick={() => wsRef.current?.send(JSON.stringify({ type: 'stop' }))}>Stop</button>
          : <button type="submit" disabled={!text.trim() || status === 'closed'}>Ask</button>}
      </form>
    </div>
  );
}
