import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchChangeTargets, type CheckoutSummary } from '../api';
import { FOLLOW, ROOT, type SideWant } from '../lib/sidePanel';

// Model: web.SidePanel launcher — what "+" opens: a search box over the
// tools the side panel offers and over the project's checkouts (the project
// and each child session's worktree), as cards. Picking one turns this tab
// into it. Enter picks the first match.

type Item = {
  key: string;
  title: string;
  detail: string;
  // Words the search matches.
  words: string;
  want: SideWant;
};

function checkoutDetail(c: CheckoutSummary): string {
  const parts = [c.branch];
  if (c.base && c.branch !== c.base) parts.push(`${c.ahead} commit${c.ahead === 1 ? '' : 's'} since ${c.base.replace(/^origin\//, '')}`);
  parts.push(c.dirty ? `${c.dirty} uncommitted` : 'nothing uncommitted');
  return parts.join(' · ');
}

export function SideLauncher({ projectId, projectName, reviewOn, followLabel, followSessionId, onPick }: {
  projectId: string;
  projectName: string;
  reviewOn: boolean;
  followLabel: string | null;
  // The Claude session the user is in (for a side chat about it).
  followSessionId?: string | null;
  onPick: (want: SideWant) => void;
}) {
  const [q, setQ] = useState('');
  const [targets, setTargets] = useState<CheckoutSummary[] | null>(null);
  const [git, setGit] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let off = false;
    fetchChangeTargets(projectId).then((r) => { if (!off) { setTargets(r.targets); setGit(r.git); } }, () => { if (!off) setTargets([]); });
    return () => { off = true; };
  }, [projectId]);

  const tools: Item[] = useMemo(() => [
    {
      key: 'follow',
      title: 'Changes',
      detail: followLabel ? `Follows the session you are in · now: ${followLabel}` : 'Follows the session you are in',
      words: 'changes diff follow session',
      want: { kind: 'changes', target: FOLLOW },
    },
    ...(followSessionId ? [{
      key: 'btw',
      title: 'Side chat (/btw)',
      detail: `Ask about ${followLabel ?? 'this session'} without interrupting it · read-only`,
      words: 'btw side chat ask question aside',
      want: { kind: 'btw', sessionId: followSessionId, label: followLabel ?? 'session' } as const,
    }] : []),
    ...(reviewOn ? [{ key: 'review', title: 'Review', detail: 'Bookmarks and comment batches', words: 'review comments batches bookmarks', want: { kind: 'review' } as const }] : []),
  ], [followLabel, followSessionId, reviewOn]);

  const checkouts: Item[] = useMemo(() => (targets ?? []).map((c) => ({
    key: c.worktree ?? ROOT,
    title: c.worktree ?? projectName,
    detail: checkoutDetail(c),
    words: `${c.worktree ?? projectName} ${c.branch} changes diff worktree`,
    want: { kind: 'changes', target: c.worktree ?? ROOT },
  })), [targets, projectName]);

  const needle = q.trim().toLowerCase();
  const match = (i: Item) => !needle || `${i.title} ${i.detail} ${i.words}`.toLowerCase().includes(needle);
  const shownTools = tools.filter(match);
  const shownCheckouts = checkouts.filter(match);

  return (
    <div className="side-launcher">
      <label className="side-launcher-search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = shownTools[0] ?? shownCheckouts[0];
              if (first) onPick(first.want);
            }
          }}
          placeholder="Search changes, worktrees and tools"
          aria-label="Search the side panel's tools and checkouts"
        />
        <kbd title="Option+T opens a new tab here">⌥T</kbd>
      </label>
      {shownTools.length > 0 && (
        <>
          <div className="side-launcher-section">Tools</div>
          <div className="side-launcher-grid">
            {shownTools.map((i) => (
              <button key={i.key} type="button" className="side-card" onClick={() => onPick(i.want)}>
                <div className="side-card-title">{i.title}</div>
                <div className="side-card-detail">{i.detail}</div>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="side-launcher-section">Checkouts</div>
      {targets === null && <div className="side-launcher-empty">Loading…</div>}
      {targets !== null && !git && <div className="side-launcher-empty">This project is not a git repository.</div>}
      {targets !== null && git && shownCheckouts.length === 0 && <div className="side-launcher-empty">Nothing matches.</div>}
      <div className="side-launcher-grid">
        {shownCheckouts.map((i) => (
          <button key={i.key} type="button" className="side-card" onClick={() => onPick(i.want)}>
            <div className="side-card-title">{i.title}</div>
            <div className="side-card-detail">{i.detail}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
