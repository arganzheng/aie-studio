import { useCallback, useEffect, useRef, useState } from 'react';
import { listSubagents, stopSubagent, type SubagentInfo } from '../api';
import { timeAgo } from '../lib/sessionList';
import { subagentStatusLabel } from '../lib/subagents';

// Model: web.SessionList tree — the subagents of one Claude session, shown
// under its row while it is expanded. Parents come before their children
// (server order); `depth` indents a subagent's own subagents.

const POLL_RUNNING_MS = 2500;

export function SessionSubagents({
  projectId,
  sessionId,
  // Changes whenever the list above re-polled: a cheap reason to look again.
  tick,
  // Subagents the list says exist / are running — refetch when they change.
  total,
  running,
  now,
  activeAgentId,
  onOpen,
  onNotice,
}: {
  projectId: string;
  sessionId: string;
  tick: number;
  total: number;
  running: number;
  now: number;
  activeAgentId: string | null;
  onOpen: (s: SubagentInfo) => void;
  onNotice: (text: string) => void;
}) {
  const [list, setList] = useState<SubagentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const l = await listSubagents(projectId, sessionId);
      if (my !== seq.current) return;
      setList(l);
      setError(null);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    }
  }, [projectId, sessionId]);

  useEffect(() => { void load(); }, [load, tick, total, running]);
  const anyRunning = running > 0 || (list ?? []).some((s) => s.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_RUNNING_MS);
    return () => window.clearInterval(t);
  }, [anyRunning, load]);

  async function stop(s: SubagentInfo) {
    try { await stopSubagent(projectId, sessionId, s.agentId); }
    catch (e) { onNotice(`Stop failed: ${(e as Error).message}`); }
    void load();
  }

  if (error) return <div className="subagent-rows-note error">{error}</div>;
  if (list === null) return <div className="subagent-rows-note">Loading…</div>;
  if (list.length === 0) return <div className="subagent-rows-note">No subagents</div>;
  return (
    <div className="subagent-rows" role="group" aria-label="Subagents">
      {list.map((s) => (
        <div
          key={s.agentId}
          className={`subagent-row ${s.status}${s.agentId === activeAgentId ? ' active' : ''}`}
          style={{ paddingLeft: 30 + Math.min(s.depth, 4) * 14 }}
          title={`${s.description}\n${s.agentType}${s.model ? ` · ${s.model}` : ''}`}
          onClick={() => onOpen(s)}
        >
          <span className={`subagent-dot ${s.status}`} aria-hidden="true" />
          <div className="session-row-main">
            <div className="session-row-title">{s.description}</div>
            <div className="session-row-sub">
              <span className={`subagent-status ${s.status}`}>{subagentStatusLabel(s)}</span>
              <span> · {s.agentType}</span>
              {s.status !== 'running' && <span> · {timeAgo(s.updatedAt, now)}</span>}
            </div>
          </div>
          {s.canStop && (
            <button
              type="button"
              className="subagent-row-stop"
              title="Stop this subagent"
              aria-label="Stop this subagent"
              onClick={(e) => { e.stopPropagation(); void stop(s); }}
            >■</button>
          )}
        </div>
      ))}
    </div>
  );
}
