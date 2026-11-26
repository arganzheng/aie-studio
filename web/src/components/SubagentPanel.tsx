import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSubagentTranscript, stopSubagent, type SubagentInfo } from '../api';
import type { Theme } from '../types';
import { LocalCommandCard } from './LocalCommandCard';
import { BangBlock, buildFromEvents, MarkdownText, summarizeTool, ToolFields, type Msg } from './SdkPanel';
import { shortTokens } from './ContextUsage';
import { subagentStatusLabel } from '../lib/subagents';
import { isInterruptNote } from '../lib/steering';

// Model: web.SubagentPanel — one subagent of a Claude session: its own
// conversation, read-only, followed live while it runs. A running one can be
// stopped (server.StopSubagent); it cannot be messaged — subagents run inside
// the session's process and the SDK has no channel to them.

const POLL_RUNNING_MS = 2000;
const POLL_IDLE_MS = 15000;

export function SubagentPanel({
  projectId,
  projectPath,
  sessionId,
  agentId,
  theme,
  onTitle,
  onOpenFile,
  onOpenParent,
}: {
  projectId: string;
  projectPath?: string;
  sessionId: string;
  agentId: string;
  theme: Theme;
  onTitle?: (title: string) => void;
  onOpenFile?: (relPath: string) => void;
  // Go to the Agent tool call in the session that spawned this subagent.
  onOpenParent?: (toolUseId: string) => void;
}) {
  const [events, setEvents] = useState<any[]>([]);
  const [info, setInfo] = useState<SubagentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stopping, setStopping] = useState(false);
  const eventsRef = useRef<any[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  const load = useCallback(async () => {
    try {
      const r = await getSubagentTranscript(projectId, sessionId, agentId, eventsRef.current.length);
      // The transcript only grows; anything else means it was rewritten.
      if (r.startIndex === eventsRef.current.length && r.events.length > 0) {
        eventsRef.current = [...eventsRef.current, ...r.events];
        setEvents(eventsRef.current);
      } else if (r.total < eventsRef.current.length) {
        eventsRef.current = [];
        setEvents([]);
      }
      setInfo(r.info);
      setError(null);
      if (r.info?.description) onTitleRef.current?.(r.info.description);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoaded(true);
  }, [projectId, sessionId, agentId]);

  const running = info?.status === 'running';
  useEffect(() => {
    eventsRef.current = [];
    setEvents([]);
    setInfo(null);
    setLoaded(false);
    void load();
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(t);
  }, [load, running]);

  // Message ids must survive a rebuild (expanded tool cards key on them):
  // derive them from the position, which is stable in an append-only log.
  const msgs = useMemo(() => buildFromEvents(events, new Map()).map((m, i): Msg => ({ ...m, id: `m${i}` })), [events]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  const rel = useCallback((s: string) => (projectPath && s ? s.split(projectPath + '/').join('') : s), [projectPath]);

  async function stop() {
    setStopping(true);
    try { await stopSubagent(projectId, sessionId, agentId); await load(); }
    catch (e) { setError((e as Error).message); }
    setStopping(false);
  }

  const facts: string[] = [];
  if (info) {
    facts.push(info.agentType);
    if (info.model) facts.push(info.model);
    if (info.toolUses != null) facts.push(`${info.toolUses} tool use${info.toolUses === 1 ? '' : 's'}`);
    if (info.totalTokens != null) facts.push(`${shortTokens(info.totalTokens)} tokens`);
    if (info.background) facts.push('background');
  }

  return (
    <div className="chat subagent-panel">
      <div className="subagent-head">
        <span className={`subagent-dot ${info?.status ?? 'done'}`} aria-hidden="true" />
        <div className="subagent-head-main">
          <div className="subagent-head-title">{info?.description ?? `Subagent ${agentId.slice(0, 8)}`}</div>
          <div className="subagent-head-sub">
            <span className={`subagent-status ${info?.status ?? ''}`}>{info ? subagentStatusLabel(info) : loaded ? 'Not found' : 'Loading…'}</span>
            {facts.map((f) => <span key={f}> · {f}</span>)}
          </div>
        </div>
        {onOpenParent && info?.toolUseId && <button type="button" className="subagent-head-btn" onClick={() => onOpenParent(info.toolUseId!)} title="Open the session that spawned this subagent">↑ Session</button>}
        {info?.canStop && (
          <button type="button" className="subagent-head-btn danger" onClick={() => void stop()} disabled={stopping} title="Stop this subagent — the session carries on and is told it was stopped">
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}
      </div>
      <div
        className="chat-messages"
        ref={scrollRef}
        onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50; }}
      >
        {error && <div className="msg msg-system">error: {error}</div>}
        {loaded && !error && msgs.length === 0 && <div className="msg msg-system">No messages yet</div>}
        {msgs.map((m) => {
          if (m.role === 'user') {
            // Claude records a stop as a user turn; it is a notice, not a prompt.
            if (isInterruptNote(m.text)) return <div key={m.id} className="msg msg-system">Stopped by the user</div>;
            return <div key={m.id} className="msg msg-user subagent-task">{m.text}</div>;
          }
          if (m.role === 'assistant') {
            return <div key={m.id} className="msg msg-assistant"><MarkdownText text={m.text} theme={theme} projectPath={projectPath} onOpenFile={onOpenFile} /></div>;
          }
          if (m.role === 'system') return <div key={m.id} className="msg msg-system">{m.text}</div>;
          if (m.role === 'bang') return <BangBlock key={m.id} msg={m} />;
          if (m.role === 'localcmd') return <LocalCommandCard key={m.id} command={m.command} output={m.output} />;
          if (m.role === 'thinking') return null;
          const isOpen = expanded.has(m.id);
          const summary = summarizeTool(m.name, m.input, rel);
          return (
            <div key={m.id} className={`msg msg-tool ${isOpen ? 'open' : ''}`}>
              <div
                className="tool-header"
                onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; })}
              >
                <span className="tool-chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="tool-name">{m.name}</span>
                {summary && <span className="tool-summary">{summary}</span>}
                {m.output === undefined && running && <span className="tool-pending">…</span>}
              </div>
              {isOpen && (
                <div className="tool-detail">
                  <ToolFields input={m.input} rel={rel} />
                  {m.output !== undefined && (
                    <div className="tool-field">
                      <div className="tool-field-key">output</div>
                      <pre className="tool-field-value">{rel(m.output)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {running && <div className="msg msg-thinking" aria-label="Subagent is working"><span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" /></div>}
      </div>
      <div className="chat-status subagent-foot">
        <span>Read-only — a subagent runs inside its session and can't be messaged{info?.canStop ? '; it can be stopped' : ''}.</span>
      </div>
    </div>
  );
}
