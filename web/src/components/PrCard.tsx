import { useEffect, useState } from 'react';
import type { PrCheckState, PrInfo, PrStatus } from '../api';

// Model: web.ChangesView "pull request" — under the branch line of the
// Changes tab: the branch's pull request (number, title, state, review,
// conflicts) and its CI checks, counted by outcome; click the counts for
// each check with a link to its run. Failed checks open the list by
// themselves.

const ICON: Record<PrCheckState, string> = { pass: '✓', fail: '✗', pending: '●', skipped: '–' };
const STATE_LABEL: Record<PrInfo['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

export function checkCounts(pr: PrInfo): Record<PrCheckState, number> {
  const n: Record<PrCheckState, number> = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  for (const c of pr.checks) n[c.state]++;
  return n;
}

export function PrCard({ status, onRefresh }: { status: PrStatus | null; onRefresh: () => void }) {
  const pr = status?.pr ?? null;
  const counts = pr ? checkCounts(pr) : null;
  const [open, setOpen] = useState<boolean | null>(null);
  // A new PR (or the first answer) resets the user's fold.
  useEffect(() => { setOpen(null); }, [pr?.url]);
  if (!status) return null;
  if (!pr) {
    if (status.unavailable) return <div className="pr-card pr-none" title={status.unavailable}>Pull request: {status.unavailable}</div>;
    if (status.branch) return <div className="pr-card pr-none">No pull request for <b>{status.branch}</b></div>;
    return null;
  }
  const listOpen = open ?? (counts!.fail > 0);
  const total = pr.checks.length;
  return (
    <div className={`pr-card pr-${pr.state}`}>
      <div className="pr-row">
        <span className={`pr-state pr-state-${pr.state}`}>{STATE_LABEL[pr.state]}</span>
        <a className="pr-title" href={pr.url} target="_blank" rel="noreferrer" title={`${pr.head} → ${pr.base} — open on GitHub`}>#{pr.number} {pr.title}</a>
        <button type="button" className="pr-refresh" title="Ask GitHub again (otherwise every 30 seconds)" aria-label="Refresh pull request" onClick={onRefresh}>⟳</button>
      </div>
      <div className="pr-row pr-sub">
        {total > 0 ? (
          <button
            type="button"
            className="pr-checks"
            aria-expanded={listOpen}
            title={listOpen ? 'Hide the checks' : 'Show each check'}
            onClick={() => setOpen(!listOpen)}
          >
            <span className="pr-caret" aria-hidden="true">{listOpen ? '▾' : '▸'}</span>
            Checks
            {counts!.fail > 0 && <span className="pr-n pr-fail">{ICON.fail} {counts!.fail}</span>}
            {counts!.pending > 0 && <span className="pr-n pr-pending">{ICON.pending} {counts!.pending}</span>}
            {counts!.pass > 0 && <span className="pr-n pr-pass">{ICON.pass} {counts!.pass}</span>}
            {counts!.skipped > 0 && <span className="pr-n pr-skipped">{ICON.skipped} {counts!.skipped}</span>}
          </button>
        ) : <span className="pr-muted">No checks</span>}
        {pr.review === 'approved' && <span className="pr-tag pr-pass">Approved</span>}
        {pr.review === 'changes-requested' && <span className="pr-tag pr-fail">Changes requested</span>}
        {pr.review === 'review-required' && <span className="pr-tag pr-muted">Review required</span>}
        {pr.mergeable === 'conflicts' && pr.state !== 'merged' && pr.state !== 'closed' && <span className="pr-tag pr-fail">Conflicts with {pr.base}</span>}
      </div>
      {listOpen && total > 0 && (
        <ul className="pr-check-list">
          {pr.checks.map((c, i) => (
            <li key={i} className={`pr-check pr-${c.state}`}>
              <span className="pr-check-icon" aria-label={c.state}>{ICON[c.state]}</span>
              <span className="pr-check-name" title={c.workflow ? `${c.workflow} / ${c.name}` : c.name}>
                {c.workflow && <span className="pr-muted">{c.workflow} / </span>}{c.name}
              </span>
              {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="pr-check-link">Details</a>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
