import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchChangeTargets, fetchPreviewPorts, type CheckoutSummary, type ListeningPort } from '../api';
import { FOLLOW, ROOT, isPreviewPort, type SideWant } from '../lib/sidePanel';

// Model: web.SidePanel launcher — what "+" opens: a search box over the
// tools the side panel offers, the dev servers running on this machine
// (Preview; web.PreviewView) and the project's checkouts (the project and
// each child session's worktree), as cards. Picking one turns this tab
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
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [portText, setPortText] = useState('');
  useEffect(() => {
    let off = false;
    fetchPreviewPorts(projectId).then((p) => { if (!off) setPorts(p); }, () => { if (!off) setPorts([]); });
    return () => { off = true; };
  }, [projectId]);
  const typedPort = Number(portText.trim().replace(/^:/, ''));

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let off = false;
    fetchChangeTargets(projectId).then((r) => { if (!off) { setTargets(r.targets); setGit(r.git); } }, () => { if (!off) setTargets([]); });
    return () => { off = true; };
  }, [projectId]);

  // Model: web.SidePanel launcher groups (like Devin's): about the session
  // you are in, then tools, previews and checkouts.
  const sessionTools: Item[] = useMemo(() => (followSessionId ? [
    { key: 'progress', title: 'Progress', detail: 'Its task list, step by step', words: 'progress plan tasks todo steps', want: { kind: 'progress' } as const },
    { key: 'agents', title: 'Agents', detail: 'Its child sessions and subagents', words: 'agents children child sessions subagents', want: { kind: 'agents' } as const },
    { key: 'artifacts', title: 'Artifacts', detail: 'Files it wrote or changed, files you attached', words: 'artifacts attachments outputs written files uploads', want: { kind: 'artifacts' } as const },
    { key: 'observe', title: 'Observe', detail: 'Turns, tool calls, tokens and time', words: 'observe trace tokens wire turns', want: { kind: 'observe' } as const },
  ] : []), [followSessionId]);

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
    { key: 'files', title: 'Files', detail: 'Browse and read the project beside the chat', words: 'files tree browse read code', want: { kind: 'files' } as const },
    ...(reviewOn ? [{ key: 'review', title: 'Review', detail: 'Bookmarks and comment batches', words: 'review comments batches bookmarks', want: { kind: 'review' } as const }] : []),
  ], [followLabel, followSessionId, reviewOn]);

  const checkouts: Item[] = useMemo(() => (targets ?? []).map((c) => ({
    key: c.worktree ?? ROOT,
    title: c.worktree ?? projectName,
    detail: checkoutDetail(c),
    words: `${c.worktree ?? projectName} ${c.branch} changes diff worktree`,
    want: { kind: 'changes', target: c.worktree ?? ROOT },
  })), [targets, projectName]);

  const previews: Item[] = useMemo(() => (ports ?? []).map((l) => ({
    key: `port:${l.port}`,
    title: `:${l.port} · ${l.command}`,
    detail: l.cwd ? (l.inProject ? `in this project${l.cwd.endsWith(`/${projectName}`) ? '' : ` · …/${l.cwd.split('/').slice(-2).join('/')}`}` : l.cwd.replace(/^\/Users\/[^/]+/, '~')) : `pid ${l.pid}`,
    words: `preview app dev server port ${l.port} ${l.command} ${l.cwd ?? ''}`,
    want: { kind: 'preview', port: l.port, path: '/' },
  })), [ports, projectName]);

  const needle = q.trim().toLowerCase();
  const match = (i: Item) => !needle || `${i.title} ${i.detail} ${i.words}`.toLowerCase().includes(needle);
  const shownSession = [...sessionTools, ...tools.filter((t) => t.key === 'btw')].filter(match);
  const shownTools = tools.filter((t) => t.key !== 'btw').filter(match);
  const shownCheckouts = checkouts.filter(match);
  const shownPreviews = previews.filter(match);

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
              const first = shownSession[0] ?? shownTools[0] ?? shownPreviews[0] ?? shownCheckouts[0];
              if (first) onPick(first.want);
            }
          }}
          placeholder="Search tools, previews and checkouts"
          aria-label="Search the side panel's tools and checkouts"
        />
        <kbd title="Option+T opens a new tab here">⌥T</kbd>
      </label>
      {shownSession.length > 0 && (
        <>
          <div className="side-launcher-section" title={followLabel ?? undefined}>This session{followLabel ? <span className="side-launcher-sub"> · {followLabel}</span> : null}</div>
          <div className="side-launcher-grid">
            {shownSession.map((i) => (
              <button key={i.key} type="button" className="side-card" onClick={() => onPick(i.want)}>
                <div className="side-card-title">{i.title}</div>
                <div className="side-card-detail">{i.detail}</div>
              </button>
            ))}
          </div>
        </>
      )}
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
      <div className="side-launcher-section" title="Apps running on this machine, shown through aie-studio's own address — on a phone too">Preview</div>
      <form
        className="side-launcher-port"
        onSubmit={(e) => { e.preventDefault(); if (isPreviewPort(typedPort)) onPick({ kind: 'preview', port: typedPort, path: '/' }); }}
      >
        <input value={portText} onChange={(e) => setPortText(e.target.value)} placeholder="Port, e.g. 5173" inputMode="numeric" aria-label="Port to preview" />
        <button type="submit" disabled={!isPreviewPort(typedPort)}>Open</button>
      </form>
      {ports === null && <div className="side-launcher-empty">Looking for running dev servers…</div>}
      {ports !== null && previews.length === 0 && <div className="side-launcher-empty">No dev server is running. Start one (or ask the agent to), or type its port.</div>}
      {shownPreviews.length > 0 && (
        <div className="side-launcher-grid">
          {shownPreviews.map((i) => (
            <button key={i.key} type="button" className="side-card" onClick={() => onPick(i.want)}>
              <div className="side-card-title side-card-port">{i.title}</div>
              <div className="side-card-detail">{i.detail}</div>
            </button>
          ))}
        </div>
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
