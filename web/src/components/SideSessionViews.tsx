import { useCallback, useEffect, useState } from 'react';
import { listAllSessions, type SubagentInfo } from '../api';
import { foldPlan, planSummary, type PlanItem, type PlanToolCall } from '../lib/plan';
import { sessionStatus, timeAgo, type SessionRow } from '../lib/sessionList';
import type { Theme } from '../types';
import type { ChatQuote } from '../lib/addToChat';
import type { FollowInfo } from './ChangesView';
import { FileTree } from './FileTree';
import { SessionSubagents } from './SessionSubagents';
import { Viewer } from './Viewer';

// Model: web.SidePanel session tools — side panel tabs about the session the
// user is working in (they follow it, like Changes does): Progress (its task
// list), Agents (its child sessions and subagents); and Files (the project's
// files, read beside the chat).

const POLL_MS = 5000;

function usePolling(fn: () => Promise<void> | void, active: boolean, deps: unknown[]) {
  useEffect(() => {
    if (!active) return;
    void fn();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void fn(); }, POLL_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ...deps]);
}

function NoSession({ what }: { what: string }) {
  return <div className="side-empty">Open a Claude session to see its {what} here. This tab follows the session you are in.</div>;
}

const MARK: Record<string, string> = { completed: '✓', in_progress: '▸', pending: '○' };

// ---- Progress ----

export function ProgressView({ projectId, follow, active }: { projectId: string; follow: FollowInfo | null; active: boolean }) {
  const sid = follow?.sessionId;
  const [plan, setPlan] = useState<PlanItem[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPlan(undefined); setError(null); }, [sid]);
  usePolling(async () => {
    if (!sid) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sid)}/transcript?plan=all`);
      if (r.status === 404) { setPlan(null); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setPlan(foldPlan((j.planTools ?? []) as PlanToolCall[]));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, active, [projectId, sid]);
  if (!sid) return <NoSession what="task list" />;
  const sum = plan ? planSummary(plan) : null;
  return (
    <div className="side-view">
      <div className="side-view-head">
        <b>Progress</b> <span className="side-muted">· {follow?.label}</span>
        {sum && <span className="side-view-count">{sum.done}/{sum.total} done</span>}
      </div>
      {error && <div className="side-empty error">{error}</div>}
      {plan === undefined && !error && <div className="side-empty">Loading…</div>}
      {plan === null && <div className="side-empty">This session has no task list yet. Claude writes one (TodoWrite / TaskCreate) for work with several steps; it shows here as it goes.</div>}
      {plan && (
        <ol className="progress-list">
          {plan.map((p, i) => (
            <li key={p.id ?? i} className={`progress-item st-${p.status}`}>
              <span className="progress-mark" aria-label={p.status}>{MARK[p.status] ?? '○'}</span>
              <span className="progress-text">{p.status === 'in_progress' && p.active ? p.active : p.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- Agents ----

export function AgentsView({ projectId, follow, active, onOpenSession, onOpenSubagent }: {
  projectId: string;
  follow: FollowInfo | null;
  active: boolean;
  onOpenSession: (row: SessionRow) => void;
  onOpenSubagent: (row: SessionRow, s: SubagentInfo) => void;
}) {
  const sid = follow?.sessionId;
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    try { setRows(await listAllSessions(projectId)); } catch { setRows([]); }
    setTick((n) => n + 1);
    setNow(Date.now());
  }, [projectId]);
  usePolling(load, active, [load]);
  if (!sid) return <NoSession what="child sessions and subagents" />;
  const me = rows?.find((r) => r.sessionId === sid && r.kind === 'claude') ?? null;
  const children = (rows ?? []).filter((r) => r.parentId === sid).sort((a, b) => b.updatedAt - a.updatedAt);
  const subs = me?.subagents;
  return (
    <div className="side-view">
      <div className="side-view-head"><b>Agents</b> <span className="side-muted">· {follow?.label}</span></div>
      {rows === null && <div className="side-empty">Loading…</div>}
      {rows !== null && (
        <>
          <div className="side-view-section">Child sessions{children.length ? ` (${children.length})` : ''}</div>
          {children.length === 0 && <div className="side-empty">None. Open one from the session's ⋯ menu in Sessions, or Claude opens them itself (spawn_child_session).</div>}
          {children.map((c) => {
            const st = sessionStatus(c, false, now);
            return (
              <button key={c.sessionId} type="button" className={`agent-row tone-${st.tone}`} onClick={() => onOpenSession(c)} title="Open this child session">
                <span className={`agent-dot ${st.tone}`} aria-hidden="true" />
                <span className="agent-title">{c.title || c.sessionId.slice(0, 8)}{c.group ? <span className="side-muted"> · {c.group}</span> : null}</span>
                <span className="agent-sub">{st.label}{c.worktree ? ` · ⎇ ${c.worktree}` : ''}</span>
              </button>
            );
          })}
          <div className="side-view-section">Subagents{subs?.total ? ` (${subs.total}, ${subs.running} running)` : ''}</div>
          {me && subs && subs.total > 0 ? (
            <div className="agent-subagents">
              <SessionSubagents
                projectId={projectId}
                sessionId={sid}
                tick={tick}
                total={subs.total}
                running={subs.running}
                now={now}
                activeAgentId={null}
                onOpen={(s) => onOpenSubagent(me, s)}
                onNotice={() => {}}
              />
            </div>
          ) : <div className="side-empty">None yet — Claude starts them with its Agent tool for searches and side jobs.</div>}
          {me && <div className="side-muted side-foot">Session updated {timeAgo(me.updatedAt, now)}</div>}
        </>
      )}
    </div>
  );
}

// ---- Files ----

export function FilesView({ projectId, projectName, projectPath, theme, onAddToChat }: {
  projectId: string;
  projectName: string;
  projectPath: string;
  theme: Theme;
  onAddToChat?: (quote: ChatQuote) => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  if (file) {
    return (
      <div className="side-view side-files">
        <div className="side-view-head">
          <button type="button" className="side-back" onClick={() => setFile(null)} title="Back to the files">← Files</button>
          <span className="side-file-path" title={file}>{file}</span>
        </div>
        <div className="side-file-body"><Viewer projectId={projectId} file={{ path: file }} theme={theme} onAddToChat={onAddToChat} /></div>
      </div>
    );
  }
  return (
    <div className="side-view side-files">
      <FileTree projectId={projectId} projectName={projectName} projectPath={projectPath} selectedPath={null} onSelect={setFile} />
    </div>
  );
}
