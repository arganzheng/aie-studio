import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getClaudeUsage, type ClaudeQuotaWindow, type ClaudeUsage as ClaudeUsageData } from '../api';

// Claude plan quota (5-hour / weekly / per-model weekly), always visible as a
// badge in the SDK chat status bar; click for the detail card.
//
// One shared store for every open tab: a single poll loop, started by the
// first mounted badge and stopped with the last. The server caches for 60s.

const POLL_MS = 2 * 60_000;

type State = { usage: ClaudeUsageData | null; loading: boolean };
let state: State = { usage: null, loading: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let mounted = 0;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function refreshClaudeUsage(force = false) {
  if (state.loading) return;
  set({ loading: true });
  getClaudeUsage(force)
    .then((usage) => set({ usage }), (e) => set({ usage: { ok: false, error: e?.message || String(e) } }))
    .finally(() => set({ loading: false }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function useClaudeUsage(): State {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (mounted++ === 0) {
      if (!state.usage) refreshClaudeUsage();
      timer = setInterval(() => { if (document.visibilityState === 'visible') refreshClaudeUsage(); }, POLL_MS);
    }
    return () => {
      if (--mounted === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return s;
}

export function levelOf(usedPercent: number): 'ok' | 'low' | 'critical' {
  return usedPercent >= 90 ? 'critical' : usedPercent >= 70 ? 'low' : 'ok';
}

export function formatReset(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets soon';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 48 ? `resets in ${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function QuotaBar({ w }: { w: ClaudeQuotaWindow }) {
  const pct = Math.round(w.usedPercent);
  const level = levelOf(pct);
  return (
    <div className="devin-quota">
      <div className="devin-quota-head">
        <span>{w.label}</span>
        <span className="devin-quota-pct" data-level={level}>{pct}% used</span>
      </div>
      <div className="devin-quota-track">
        <div className="devin-quota-fill" data-level={level} style={{ width: `${pct}%` }} />
      </div>
      <div className="settings-option-hint">
        {formatReset(w.resetAt)}
        {w.resetAt && ` · ${new Date(w.resetAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
      </div>
    </div>
  );
}

function ClaudeUsageDialog({ s, onClose }: { s: State; onClose: () => void }) {
  const { usage, loading } = s;
  let body: ReactNode;
  if (!usage) {
    body = <div className="settings-option-hint">Loading…</div>;
  } else if (!usage.ok) {
    body = usage.error === 'not_available' ? (
      <div className="settings-option-hint">
        Plan limits don't apply to this login (API key, Bedrock or Vertex). Sign in with a claude.ai Pro / Max plan to see quota.
      </div>
    ) : (
      <div className="settings-option-hint" style={{ color: 'var(--color-error, #d33)' }}>
        Usage unavailable: {usage.error}
      </div>
    );
  } else {
    body = (
      <>
        {usage.windows.map((w) => <QuotaBar key={w.key} w={w} />)}
        {usage.windows.length === 0 && <div className="settings-option-hint">No quota information reported for this account.</div>}
        <div className="settings-option-hint">
          {usage.plan && <>{usage.plan[0].toUpperCase() + usage.plan.slice(1)} plan · </>}
          Fetched {new Date(usage.fetchedAt).toLocaleTimeString()} · same data as the CLI's <code className="settings-mono">/usage</code>
        </div>
      </>
    );
  }
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Claude usage</span>
          <button className="settings-signout devin-usage-refresh" onClick={() => refreshClaudeUsage(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">{body}</div>
        </div>
      </div>
    </div>
  );
}

export function ClaudeUsageBadge() {
  const s = useClaudeUsage();
  const [open, setOpen] = useState(false);
  const usage = s.usage;
  let content: ReactNode;
  let title = 'Claude plan usage — click for details';
  if (!usage) {
    content = <span className="claude-usage-seg">quota …</span>;
  } else if (!usage.ok || usage.windows.length === 0) {
    content = <span className="claude-usage-seg">quota ?</span>;
    title = usage.ok ? 'No quota reported' : `Quota unavailable: ${usage.error}`;
  } else {
    content = usage.windows.map((w, i) => (
      <span key={w.key} className="claude-usage-seg" data-level={levelOf(w.usedPercent)}>
        {i > 0 && <span className="claude-usage-sep">·</span>}
        {w.short} {Math.round(w.usedPercent)}%
      </span>
    ));
    title = usage.windows.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used${w.resetAt ? `, ${formatReset(w.resetAt)}` : ''}`).join('\n');
  }
  return (
    <>
      <button className="claude-usage-badge" type="button" title={title} onClick={() => setOpen(true)}>{content}</button>
      {open && <ClaudeUsageDialog s={s} onClose={() => setOpen(false)} />}
    </>
  );
}
