import { useCallback, useEffect, useState } from 'react';
import {
  deleteAutomation, listAllSessions, listAutomations, rotateAutomationToken, runAutomationNow, saveAutomation,
  type Automation, type AutomationDraft, type AutomationRun,
} from '../api';
import type { SessionRow } from '../lib/sessionList';
import type { Project } from '../types';

// Model: web.Automations — "when <trigger>, do <action>" (server/src/
// automations.ts): a schedule (cron) or a webhook URL starts a new Claude
// session with a prompt, or writes the prompt into an existing session.
// The list shows each automation with its next run, "Run now", and the
// webhook's URL; below it the recent runs, each opening its session.

const PRESETS: ReadonlyArray<[string, string]> = [
  ['Every hour', '0 * * * *'],
  ['Every day 09:00', '0 9 * * *'],
  ['Weekdays 09:00', '0 9 * * 1-5'],
  ['Mondays 09:00', '0 9 * * 1'],
];

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function webhookUrl(token: string): string { return `${window.location.origin}/hooks/${token}`; }

function emptyDraft(projectId: string): AutomationDraft {
  return { name: '', enabled: true, trigger: { kind: 'schedule', cron: '0 9 * * *' }, action: { kind: 'new-session', projectId }, prompt: '' };
}

function Editor({ projects, initial, id, onSaved, onCancel }: {
  projects: Project[];
  initial: AutomationDraft;
  id: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<AutomationDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const projectId = d.action.projectId;
  useEffect(() => {
    if (d.action.kind !== 'message') return;
    let off = false;
    listAllSessions(projectId).then((rows) => { if (!off) setSessions(rows.filter((r) => r.kind === 'claude' && !r.archived && r.projectId === projectId)); }, () => { if (!off) setSessions([]); });
    return () => { off = true; };
  }, [d.action.kind, projectId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try { await saveAutomation(id, d); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const cron = d.trigger.kind === 'schedule' ? d.trigger.cron : '';

  return (
    <div className="auto-editor">
      <label className="auto-field">
        <span>Name</span>
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Nightly issue triage" autoFocus />
      </label>
      <div className="auto-field">
        <span>When</span>
        <div className="sessions-seg">
          <button type="button" className={d.trigger.kind === 'schedule' ? 'on' : ''} onClick={() => setD({ ...d, trigger: { kind: 'schedule', cron: cron || '0 9 * * *' } })}>On a schedule</button>
          <button type="button" className={d.trigger.kind === 'webhook' ? 'on' : ''} onClick={() => setD({ ...d, trigger: { kind: 'webhook' } })}>On a webhook</button>
        </div>
      </div>
      {d.trigger.kind === 'schedule' ? (
        <div className="auto-field">
          <span>Schedule</span>
          <div className="auto-presets">
            {PRESETS.map(([label, c]) => (
              <button key={c} type="button" className={cron === c ? 'on' : ''} onClick={() => setD({ ...d, trigger: { kind: 'schedule', cron: c } })}>{label}</button>
            ))}
          </div>
          <input className="auto-mono" value={cron} onChange={(e) => setD({ ...d, trigger: { kind: 'schedule', cron: e.target.value } })} aria-label="Cron expression" />
          <div className="auto-hint">cron: minute hour day-of-month month day-of-week, in the server's time. Runs missed while the server was down are not made up.</div>
        </div>
      ) : (
        <div className="auto-hint">A secret URL is made when you save. POST to it (JSON or text); the body goes into the prompt.</div>
      )}
      <div className="auto-field">
        <span>Do</span>
        <div className="sessions-seg">
          <button type="button" className={d.action.kind === 'new-session' ? 'on' : ''} onClick={() => setD({ ...d, action: { kind: 'new-session', projectId } })}>Start a new session</button>
          <button type="button" className={d.action.kind === 'message' ? 'on' : ''} onClick={() => setD({ ...d, action: { kind: 'message', projectId, sessionId: '' } })}>Message a session</button>
        </div>
      </div>
      <label className="auto-field">
        <span>Project</span>
        <select value={projectId} onChange={(e) => setD({ ...d, action: d.action.kind === 'message' ? { kind: 'message', projectId: e.target.value, sessionId: '' } : { ...d.action, projectId: e.target.value } })}>
          {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {d.action.kind === 'new-session' ? (
        <>
          <label className="auto-field">
            <span>Model</span>
            <input value={d.action.model ?? ''} onChange={(e) => setD({ ...d, action: { ...(d.action as Extract<AutomationDraft['action'], { kind: 'new-session' }>), model: e.target.value } })} placeholder="default" />
          </label>
          <label className="auto-check">
            <input type="checkbox" checked={d.action.worktree === true} onChange={(e) => setD({ ...d, action: { ...(d.action as Extract<AutomationDraft['action'], { kind: 'new-session' }>), worktree: e.target.checked } })} />
            Run it in its own git worktree and branch (.claude/worktrees/), so its edits stay apart
          </label>
        </>
      ) : (
        <label className="auto-field">
          <span>Session</span>
          <select value={d.action.sessionId} onChange={(e) => setD({ ...d, action: { kind: 'message', projectId, sessionId: e.target.value } })}>
            <option value="">{sessions === null ? 'Loading…' : sessions.length ? 'Pick a Claude session' : 'No Claude sessions in this project'}</option>
            {(sessions ?? []).map((s) => <option key={s.sessionId} value={s.sessionId}>{s.title || s.sessionId.slice(0, 8)}</option>)}
          </select>
        </label>
      )}
      <label className="auto-field">
        <span>Prompt</span>
        <textarea rows={6} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} placeholder={'Look at the issues opened since yesterday ({{date}}), label them, and list the ones that need me.'} />
      </label>
      <div className="auto-hint">{'{{date}}'} becomes the run's date and time; {'{{body}}'} the webhook's body (without it, the body is added after the prompt).</div>
      {error && <div className="auto-error">{error}</div>}
      <div className="auto-buttons">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : id ? 'Save' : 'Create'}</button>
      </div>
    </div>
  );
}

export function AutomationsDialog({ projects, activeProjectId, onOpenSession, onClose }: {
  projects: Project[];
  activeProjectId: string | null;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ automations: Automation[]; runs: AutomationRun[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: AutomationDraft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const load = useCallback(() => { listAutomations().then(setData, (e) => setError(String(e.message ?? e))); }, []);
  useEffect(() => { load(); const t = window.setInterval(load, 10_000); return () => window.clearInterval(t); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'missing project';
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    setBusy(null);
    load();
  };
  const copy = (text: string, key: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(key); window.setTimeout(() => setCopied(null), 1500); }); };
  const defaultProject = activeProjectId ?? projects.find((p) => !p.archived)?.id ?? '';

  return (
    <div className="settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !editing) onClose(); }}>
      <div className="settings-modal auto-modal" role="dialog" aria-label="Automations">
        <div className="settings-header">
          <span>{editing ? (editing.id ? 'Edit automation' : 'New automation') : 'Automations'}</span>
          <button className="settings-close" onClick={editing ? () => setEditing(null) : onClose} aria-label="Close">×</button>
        </div>
        {editing ? (
          <Editor projects={projects} initial={editing.draft} id={editing.id} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        ) : (
          <div className="auto-body">
            <div className="auto-intro">
              Start a Claude session on a schedule or when something calls a webhook — or write into one you already have. Runs show up in Sessions like any other session, and alert you when they finish.
              <button type="button" className="primary" disabled={!defaultProject} onClick={() => setEditing({ id: null, draft: emptyDraft(defaultProject) })}>＋ New automation</button>
            </div>
            {error && <div className="auto-error">{error}</div>}
            {data === null && !error && <div className="auto-empty">Loading…</div>}
            {data?.automations.length === 0 && <div className="auto-empty">No automations yet.</div>}
            {data?.automations.map((a) => (
              <div key={a.id} className={`auto-item${a.enabled ? '' : ' off'}`}>
                <div className="auto-item-head">
                  <label className="auto-toggle" title={a.enabled ? 'On — click to turn off' : 'Off — click to turn on'}>
                    <input type="checkbox" checked={a.enabled} onChange={(e) => void act(a.id, () => saveAutomation(a.id, { ...a, enabled: e.target.checked }))} />
                  </label>
                  <span className="auto-name">{a.name}</span>
                  <button type="button" disabled={busy === a.id} onClick={() => void act(a.id, () => runAutomationNow(a.id))} title="Run it once now">{busy === a.id ? 'Running…' : '▶ Run now'}</button>
                  <button type="button" onClick={() => setEditing({ id: a.id, draft: { name: a.name, enabled: a.enabled, trigger: a.trigger.kind === 'schedule' ? a.trigger : { kind: 'webhook' }, action: a.action, prompt: a.prompt } })}>Edit</button>
                  <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete "${a.name}"?`)) void act(a.id, () => deleteAutomation(a.id)); }}>Delete</button>
                </div>
                <div className="auto-item-sub">
                  {a.trigger.kind === 'schedule'
                    ? <>⏱ {a.schedule ?? a.trigger.cron}{a.nextRunAt ? <span className="auto-muted"> · next {when(a.nextRunAt)}</span> : null}</>
                    : <>🔗 Webhook</>}
                  {' → '}
                  {a.action.kind === 'new-session'
                    ? <>new session in <b>{projectName(a.action.projectId)}</b>{a.action.worktree ? ' (own worktree)' : ''}{a.action.model ? ` · ${a.action.model}` : ''}</>
                    : <>message to a session in <b>{projectName(a.action.projectId)}</b></>}
                </div>
                {a.trigger.kind === 'webhook' && (
                  <div className="auto-hook">
                    <code className="auto-mono">{webhookUrl(a.trigger.token)}</code>
                    <button type="button" onClick={() => copy(webhookUrl((a.trigger as { token: string }).token), `${a.id}:url`)}>{copied === `${a.id}:url` ? 'Copied' : 'Copy URL'}</button>
                    <button type="button" onClick={() => copy(`curl -X POST -H 'Content-Type: application/json' -d '{"text":"hello"}' ${webhookUrl((a.trigger as { token: string }).token)}`, `${a.id}:curl`)}>{copied === `${a.id}:curl` ? 'Copied' : 'Copy curl'}</button>
                    <button type="button" title="Make a new secret URL; the old one stops working" onClick={() => { if (window.confirm('Make a new URL? The current one stops working.')) void act(a.id, () => rotateAutomationToken(a.id)); }}>New URL</button>
                  </div>
                )}
                <div className="auto-prompt" title={a.prompt}>{a.prompt}</div>
              </div>
            ))}
            {data && data.runs.length > 0 && (
              <>
                <div className="auto-section">Recent runs</div>
                {data.runs.slice(0, 30).map((r) => (
                  <div key={r.id} className={`auto-run${r.ok ? '' : ' failed'}`}>
                    <span className="auto-run-mark">{r.ok ? '✓' : '✗'}</span>
                    <span className="auto-run-when">{when(r.at)}</span>
                    <span className="auto-run-name">{r.name}</span>
                    <span className="auto-muted">{r.source === 'manual' ? 'by hand' : r.source}</span>
                    {r.ok && r.sessionId
                      ? <button type="button" onClick={() => { onOpenSession(r.projectId, r.sessionId!); onClose(); }}>Open session</button>
                      : <span className="auto-run-error" title={r.error}>{r.error}</span>}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
