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

// ---- Artifacts ----

// Model: web.ArtifactsView — what the session produced and what it was handed:
// the files Claude wrote or edited (newest first; the ones in the project open
// here), and the files the user attached to a prompt (kept on the server for a
// week; images show here, other files open in a new tab).
export type ArtifactFile = { path: string; inProject: boolean; created: boolean; edits: number; lastAt: string | null; viaShell?: boolean };
export type ArtifactAttachment =
  | { kind: 'file'; path: string; name: string; at: string | null }
  | { kind: 'image'; ref: string; name: string; mediaType: string; at: string | null };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
export const attachmentUrl = (p: string) => `/api/attachments/file?path=${encodeURIComponent(p)}`;

function when(at: string | null, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? timeAgo(t, now) : '';
}

export function ArtifactsView({ projectId, follow, active, theme, onAddToChat }: {
  projectId: string;
  follow: FollowInfo | null;
  active: boolean;
  theme: Theme;
  onAddToChat?: (quote: ChatQuote) => void;
}) {
  const sid = follow?.sessionId;
  const [data, setData] = useState<{ files: ArtifactFile[]; attachments: ArtifactAttachment[] } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // file: a project file; image: an image by URL (an attachment or a pasted image).
  const [open, setOpen] = useState<{ kind: 'file'; path: string } | { kind: 'image'; url: string; name: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setData(undefined); setError(null); setOpen(null); }, [sid]);
  usePolling(async () => {
    if (!sid) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sid)}/transcript?artifacts=1`);
      if (r.status === 404) { setData(null); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData({ files: j.files ?? [], attachments: j.attachments ?? [] });
      setNow(Date.now());
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, active, [projectId, sid]);
  if (!sid) return <NoSession what="artifacts" />;
  if (open) {
    const name = open.kind === 'file' ? open.path.slice(open.path.lastIndexOf('/') + 1) : open.name;
    return (
      <div className="side-view side-files">
        <div className="side-view-head">
          <button type="button" className="side-back" onClick={() => setOpen(null)} title="Back to the artifacts">← Artifacts</button>
          <span className="side-file-path" title={open.kind === 'file' ? open.path : name}>{open.kind === 'file' ? open.path : name}</span>
        </div>
        <div className="side-file-body">
          {open.kind === 'file'
            ? <Viewer projectId={projectId} file={{ path: open.path }} theme={theme} onAddToChat={onAddToChat} />
            : <div className="artifact-image"><img src={open.url} alt={name} /></div>}
        </div>
      </div>
    );
  }
  const files = data?.files ?? [];
  const atts = data?.attachments ?? [];
  return (
    <div className="side-view">
      <div className="side-view-head"><b>Artifacts</b> <span className="side-muted">· {follow?.label}</span></div>
      {error && <div className="side-empty error">{error}</div>}
      {data === undefined && !error && <div className="side-empty">Loading…</div>}
      {data === null && <div className="side-empty">This session has not written anything yet.</div>}
      {data && (
        <>
          <div className="side-view-section">Files written{files.length ? ` (${files.length})` : ''}</div>
          {files.length === 0 && <div className="side-empty">None yet. Files Claude creates or edits (its file tools, or a shell redirect) show here.</div>}
          {files.map((f) => {
            const name = f.path.slice(f.path.lastIndexOf('/') + 1);
            const dir = f.path.slice(0, f.path.length - name.length);
            const meta = `${f.viaShell ? 'written by a shell command' : f.created ? 'created' : 'edited'}${f.edits > 1 ? ` · ${f.edits} changes` : ''}${f.lastAt ? ` · ${when(f.lastAt, now)}` : ''}${f.inProject ? '' : ' · outside the project'}`;
            return f.inProject ? (
              <button key={f.path} type="button" className="artifact-row" onClick={() => setOpen({ kind: 'file', path: f.path })} title={`Open ${f.path}`}>
                <span className={`artifact-badge ${f.viaShell ? 'sh' : f.created ? 'new' : 'mod'}`}>{f.viaShell ? 'W' : f.created ? 'A' : 'M'}</span>
                <span className="artifact-name">{name}<span className="side-muted"> {dir}</span></span>
                <span className="artifact-meta">{meta}</span>
              </button>
            ) : (
              <div key={f.path} className="artifact-row static" title={f.path}>
                <span className={`artifact-badge ${f.viaShell ? 'sh' : f.created ? 'new' : 'mod'}`}>{f.viaShell ? 'W' : f.created ? 'A' : 'M'}</span>
                <span className="artifact-name">{name}<span className="side-muted"> {dir}</span></span>
                <span className="artifact-meta">{meta}</span>
              </div>
            );
          })}
          <div className="side-view-section">Attachments{atts.length ? ` (${atts.length})` : ''}</div>
          {atts.length === 0 && <div className="side-empty">None. Files you attach to a message (＋ in the input, paste or drop) show here.</div>}
          {atts.map((a) => {
            const at = a.at ? `${a.kind === 'image' ? 'pasted' : 'attached'} ${when(a.at, now)}` : a.kind === 'image' ? 'pasted' : 'attached';
            const url = a.kind === 'image'
              ? `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sid)}/transcript?image=${encodeURIComponent(a.ref)}`
              : attachmentUrl(a.path);
            const key = a.kind === 'image' ? a.ref : a.path;
            return a.kind === 'image' || IMAGE_EXT.test(a.name) ? (
              <button key={key} type="button" className="artifact-row" onClick={() => setOpen({ kind: 'image', url, name: a.name })} title={a.kind === 'file' ? a.path : a.name}>
                <img className="artifact-thumb" src={url} alt="" loading="lazy" />
                <span className="artifact-name">{a.name}</span>
                <span className="artifact-meta">{at}</span>
              </button>
            ) : (
              <a key={key} className="artifact-row" href={url} target="_blank" rel="noopener noreferrer" title={`${a.path} — opens in a new tab`}>
                <span className="artifact-badge att">⎙</span>
                <span className="artifact-name">{a.name}</span>
                <span className="artifact-meta">{at} ↗</span>
              </a>
            );
          })}
        </>
      )}
    </div>
  );
}
