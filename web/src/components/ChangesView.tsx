import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChangedFile, fetchChanges, fetchPrStatus, markChangesSeen, type ChangesResult, type ChangesScope, type DiffFile, type DiffLine, type PrStatus, type SessionChangesResult, type SessionScope } from '../api';
import { copyText } from '../lib/clipboard';
import { fileGaps, fileKey, gapView, keepUnchangedFiles, pointTime, sessionFiles, pairWordDiffs, splitPath, type Gap, type GapOpen, type Seg } from '../lib/diffView';
import { PrCard } from './PrCard';
import type { ChatQuote } from '../lib/addToChat';
import { diffQuoteSource, statusLetter, type DiffRowRef } from '../lib/diffQuote';
import { FOLLOW, ROOT } from '../lib/sidePanel';
import { AddToChatSelection } from './CommentComposer';

// Model: web.ChangesView — the side panel's Changes tab, file by file. A tab
// that follows a session shows what that session changed (in every checkout
// it worked in) since it began, since the user's last message or since they
// last marked the changes seen; any tab can also show what a checkout
// changed since its branch left the main branch (or only what is not
// committed yet). It refreshes itself while it is on screen, so
// it keeps up with an agent that is still editing. Selecting lines offers
// "Add to chat" with the file and line span.

// The session the user is working in, for a tab that follows it.
export type FollowInfo = { sessionId?: string; worktree?: string; label: string };

const POLL_MS = 5000;
// The pull request is asked about less often (the server caches it 30 s too).
const PR_POLL_MS = 30_000;
// Files bigger than this start folded; so does everything after the first few.
const OPEN_LINE_LIMIT = 300;
const OPEN_FILE_LIMIT = 20;

function lineCount(f: DiffFile): number {
  return f.hunks.reduce((n, h) => n + h.lines.length, 0);
}

// Selection → the diff rows it covers (start and end rows, and those between).
function selectedRows(root: HTMLElement): DiffRowRef[] {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const rows = [...root.querySelectorAll<HTMLElement>('.diff-line[data-path]')].filter((el) => range.intersectsNode(el));
  return rows.map((el) => ({
    path: el.dataset.path!,
    oldNo: el.dataset.old ? Number(el.dataset.old) : undefined,
    newNo: el.dataset.new ? Number(el.dataset.new) : undefined,
  }));
}

// Lines a fold bar opens per click (Devin opens 5; prose diffs want more).
const GAP_STEP = 20;

type RowProps = { path: string; t: DiffLine['t']; text: string; oldNo?: number; newNo?: number; segs?: Seg[] };

function DiffRow({ path, t, text, oldNo, newNo, segs }: RowProps) {
  const kind = t === '+' ? 'add' : t === '-' ? 'del' : t === '\\' ? 'meta' : 'ctx';
  return (
    <div className={`diff-line ${kind}`} data-path={path} data-old={oldNo ?? undefined} data-new={newNo ?? undefined}>
      <span className="diff-ln">{t === '-' ? oldNo : newNo ?? ''}</span>
      <span className="diff-sign" aria-hidden="true">{t === '+' ? '+' : t === '-' ? '−' : ''}</span>
      <span className="diff-code">
        {segs
          ? segs.map((sg, i) => (sg.changed ? <mark key={i} className="diff-word">{sg.text}</mark> : <span key={i}>{sg.text}</span>))
          : text || ' '}
      </span>
    </div>
  );
}

const FileDiff = memo(function FileDiff({ file, open, onToggle, loadText, repoName }: {
  file: DiffFile;
  open: boolean;
  onToggle: (key: string) => void;
  // The new version on disk, for the folded stretches.
  loadText: (path: string, repo?: string) => Promise<string>;
  // Session scopes: the checkout's name, shown after the directory.
  repoName?: string;
}) {
  const [gapOpen, setGapOpen] = useState<Map<number, GapOpen>>(new Map());
  const [lines, setLines] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // A different diff for this file (the agent kept editing): fold again.
  const shape = `${file.additions}|${file.deletions}|${file.hunks.map((h) => h.header).join('|')}`;
  useEffect(() => { setGapOpen(new Map()); setLines(null); setLoadError(null); }, [shape]);

  const gaps = useMemo(() => fileGaps(file, file.newLines), [file]);
  const words = useMemo(() => file.hunks.map((h) => pairWordDiffs(h.lines)), [file]);
  const fileLines = file.newLines ?? (lines ? lines.length : null);

  const openGap = async (gap: Gap, change: (g: GapOpen, size: number) => GapOpen) => {
    let known = fileLines;
    if (!lines) {
      try {
        const ls = (await loadText(file.path, file.repo)).split('\n');
        if (ls[ls.length - 1] === '') ls.pop();
        setLines(ls);
        setLoadError(null);
        known = file.newLines ?? ls.length;
      } catch (e) { setLoadError(String((e as Error).message ?? e)); return; }
    }
    const size = Math.max(0, (gap.to ?? known ?? 0) - gap.from + 1);
    setGapOpen((prev) => new Map(prev).set(gap.before, change(prev.get(gap.before) ?? { top: 0, bottom: 0 }, size)));
  };

  const ctxRow = (gap: Gap, n: number) => (
    <DiffRow key={`c${n}`} path={file.path} t=" " text={lines?.[n - 1] ?? ''} oldNo={n + gap.oldOffset} newNo={n} />
  );

  const renderGap = (gap: Gap) => {
    const st = gapOpen.get(gap.before) ?? { top: 0, bottom: 0 };
    const v = gapView(gap, st, fileLines);
    const first = gap.before === 0;
    const last = gap.before === file.hunks.length;
    const hidden = v.hidden;
    return (
      <div key={`g${gap.before}`} className="diff-gap">
        {v.top.map((n) => ctxRow(gap, n))}
        {hidden !== 0 && (
          <div className="diff-fold">
            {!first && (hidden == null || hidden > GAP_STEP) && (
              <button type="button" onClick={() => void openGap(gap, (g) => ({ ...g, top: g.top + GAP_STEP }))} title="Show more lines below the change above">↧ {GAP_STEP} lines</button>
            )}
            <button type="button" onClick={() => void openGap(gap, (_g, sz) => ({ top: sz, bottom: 0 }))} title="Show all the unchanged lines here">
              ↕ {hidden == null ? 'All lines' : `All ${hidden} line${hidden === 1 ? '' : 's'}`}
            </button>
            {!last && (hidden == null || hidden > GAP_STEP) && (
              <button type="button" onClick={() => void openGap(gap, (g) => ({ ...g, bottom: g.bottom + GAP_STEP }))} title="Show more lines above the change below">↥ {GAP_STEP} lines</button>
            )}
            {loadError && <span className="diff-fold-error">Could not read the file: {loadError}</span>}
          </div>
        )}
        {v.bottom.map((n) => ctxRow(gap, n))}
      </div>
    );
  };

  const { name, dir } = splitPath(file.path);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyText(file.path).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1200); } });
  };
  const gapBefore = new Map(gaps.map((g) => [g.before, g]));

  return (
    <div className={`diff-file ${file.status}`}>
      <div className="diff-file-head" role="button" tabIndex={0} aria-expanded={open}
        onClick={() => onToggle(fileKey(file))}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(fileKey(file)); } }}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <span className="diff-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={`diff-status s-${file.status}`} title={file.status}>{statusLetter(file.status)}</span>
        <span className="diff-path">
          <span className="diff-name">{name}</span>
          {(dir || file.oldPath || repoName) && <span className="diff-dir">{[file.oldPath ? `from ${file.oldPath}` : dir, repoName].filter(Boolean).join(' · ')}</span>}
        </span>
        {file.touched && <span className="diff-touched" title="This session edited this file">✎</span>}
        <button type="button" className="diff-copy" onClick={copy} title="Copy the path" aria-label="Copy the path">{copied ? '✓' : '⧉'}</button>
        {file.binary
          ? <span className="diff-note">binary</span>
          : <span className="diff-counts"><span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span></span>}
      </div>
      {open && !file.binary && (
        <div className="diff-body">
          {file.hunks.map((h, i) => (
            <div key={i} className="diff-hunk">
              {gapBefore.has(i) && renderGap(gapBefore.get(i)!)}
              {h.lines.map((l, j) => <DiffRow key={j} path={file.path} t={l.t} text={l.text} oldNo={l.oldNo} newNo={l.newNo} segs={words[i].get(j)} />)}
            </div>
          ))}
          {gapBefore.has(file.hunks.length) && renderGap(gapBefore.get(file.hunks.length)!)}
          {file.truncated && <div className="diff-truncated">Too long — the rest of this file is not shown.</div>}
        </div>
      )}
    </div>
  );
});

const SCOPE_LABEL: Record<ChangesScope, string> = {
  all: 'All changes',
  turn: 'Last agent turn',
  seen: 'Since last seen',
  base: 'Since main',
  uncommitted: 'Uncommitted',
};
const isSessionScope = (s: ChangesScope): s is SessionScope => s === 'all' || s === 'turn' || s === 'seen';
const isSessionResult = (d: ChangesResult | SessionChangesResult | null): d is SessionChangesResult => !!d && 'session' in d;

export function ChangesView({ projectId, projectName, target, follow, active, onAddToChat }: {
  projectId: string;
  projectName: string;
  // FOLLOW, ROOT or a worktree name (lib/sidePanel).
  target: string;
  follow: FollowInfo | null;
  // On screen: only then does it poll.
  active: boolean;
  onAddToChat?: (quote: ChatQuote) => void;
}) {
  const query = useMemo(() => {
    if (target === FOLLOW) return { worktree: follow?.worktree ?? null, session: follow?.sessionId ?? null };
    if (target === ROOT) return { worktree: null, session: null };
    return { worktree: target, session: null };
  }, [target, follow?.worktree, follow?.sessionId]);
  // Model: web.ChangesView "session scopes" — a tab that follows a session
  // starts with what the session changed; a checkout tab with its branch.
  const sessionId = query.session;
  const [scope, setScope] = useState<ChangesScope>(sessionId ? 'all' : 'base');
  // The session has no snapshot yet: shown as its branch until it has one.
  const [noSnapshot, setNoSnapshot] = useState(false);
  useEffect(() => { setScope(sessionId ? 'all' : 'base'); setNoSnapshot(false); }, [sessionId, target]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const [data, setData] = useState<ChangesResult | SessionChangesResult | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Files the user folded or unfolded; the rest follow the default.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pr, setPr] = useState<PrStatus | null>(null);

  const key = `${projectId}|${query.worktree ?? ''}|${query.session ?? ''}|${scope}`;

  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (inflight.current) return;
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    try {
      if (isSessionScope(scope)) {
        const r = await fetchChanges(projectId, { ...query, scope }, ac.signal);
        if (ac.signal.aborted) return;
        if (r.none) { setNoSnapshot(true); setScope('base'); return; }
        setData(r);
        setFiles((prev) => keepUnchangedFiles(prev, sessionFiles(r)));
      } else {
        const r = await fetchChanges(projectId, { ...query, scope }, ac.signal);
        if (ac.signal.aborted) return;
        setData(r);
        setFiles((prev) => keepUnchangedFiles(prev, r.git ? r.files : []));
      }
      setError(null);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // A session just started is not on the server's list for a moment:
      // the next poll finds it, so no red error in between.
      if (!ac.signal.aborted && !(isSessionScope(scope) && /session not found/.test(msg))) setError(msg);
    } finally {
      if (inflight.current === ac) inflight.current = null;
      setLoading(false);
    }
  }, [projectId, query, scope]);

  // Model: web.ChangesView "pull request" — the checkout's branch's PR.
  const prKey = `${projectId}|${query.worktree ?? ''}|${query.session ?? ''}`;
  const loadPr = useCallback(async (fresh = false) => {
    try { setPr(await fetchPrStatus(projectId, { ...query, fresh })); }
    catch (e) { setPr({ pr: null, unavailable: String((e as Error).message ?? e) }); }
  }, [projectId, query]);
  useEffect(() => { setPr(null); }, [prKey]);
  useEffect(() => {
    if (!active) return;
    void loadPr();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void loadPr(); }, PR_POLL_MS);
    return () => window.clearInterval(t);
  }, [active, loadPr]);
  // Asks again when the branch changes under the tab.
  const branch = data && !isSessionResult(data) && data.git ? data.branch : null;
  useEffect(() => { if (active && branch && pr && pr.branch !== undefined && pr.branch !== branch) void loadPr(); }, [active, branch, pr, loadPr]);

  // A different checkout or scope: start over.
  useEffect(() => {
    inflight.current?.abort();
    inflight.current = null;
    setData(null);
    setFiles([]);
    setError(null);
    setToggled(new Map());
  }, [key]);

  useEffect(() => {
    if (!active) return;
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [active, load]);

  const loadText = useCallback((p: string, repo?: string) => fetchChangedFile(projectId, { ...query, path: p, repo }), [projectId, query]);

  const isOpen = (f: DiffFile, i: number) => toggled.get(fileKey(f)) ?? (i < OPEN_FILE_LIMIT && lineCount(f) <= OPEN_LINE_LIMIT);
  const onToggle = useCallback((k: string) => {
    setToggled((prev) => {
      const i = files.findIndex((f) => fileKey(f) === k);
      const cur = prev.get(k) ?? (i < OPEN_FILE_LIMIT && i >= 0 && lineCount(files[i]) <= OPEN_LINE_LIMIT);
      return new Map(prev).set(k, !cur);
    });
  }, [files]);
  const setAll = (open: boolean) => setToggled(new Map(files.map((f) => [fileKey(f), open])));

  const [marking, setMarking] = useState(false);
  const markSeen = async () => {
    if (!sessionId) return;
    setMenuOpen(false);
    setMarking(true);
    try { await markChangesSeen(projectId, sessionId); } catch (e) { setError(String((e as Error).message ?? e)); }
    setMarking(false);
    void load();
  };

  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const where = data?.worktree ? `worktree ${data.worktree}` : projectName;
  const sess = isSessionResult(data) ? data : null;
  const br = data && !isSessionResult(data) ? data : null;
  const baseName = br?.git && br.base ? br.base.replace(/^origin\//, '') : 'main';
  const label = (s: ChangesScope) => (s === 'base' ? `Since ${baseName}` : SCOPE_LABEL[s]);
  const points = sess?.points;
  const repoCount = sess ? sess.repos.filter((r) => r.files.length > 0).length : 0;
  const repoName = (root?: string) => (root ? root.split('/').pop() ?? root : '');

  // The menu: the session's scopes (a tab that follows a session), then the branch's.
  const items: Array<{ scope: ChangesScope; detail: string }> = [
    ...(sessionId ? [
      { scope: 'all' as const, detail: noSnapshot ? 'Starts with your next message to this session' : points?.start ? `Everything this session changed since ${pointTime(points.start)}` : 'Everything this session changed' },
      { scope: 'turn' as const, detail: 'Since your last message' },
      { scope: 'seen' as const, detail: points?.seen ? `Changes after ${pointTime(points.seen)}` : 'Not marked yet — same as All changes' },
    ] : []),
    { scope: 'base', detail: 'This checkout’s branch: commits and uncommitted work' },
    { scope: 'uncommitted', detail: 'Only what is not committed yet' },
  ];

  return (
    <div className="changes">
      <div className="changes-head">
        <div className="changes-row">
          {sess ? (
            <span className="changes-branch" title="What this session changed, in every checkout it worked in">
              <b>This session</b>
              {scope === 'turn' && points?.turn && <span className="changes-muted"> since {pointTime(points.turn)}</span>}
              {scope === 'seen' && points?.seen && <span className="changes-muted"> since {pointTime(points.seen)}</span>}
              {scope === 'all' && points?.start && <span className="changes-muted"> since {pointTime(points.start)}</span>}
            </span>
          ) : br?.git ? (
            <span className="changes-branch" title={br.mergeBase ? `${br.branch}, compared with ${br.base} at ${br.mergeBase.slice(0, 8)}` : br.branch}>
              <b>{br.branch}</b>
              {scope === 'base' && br.base && br.branch !== br.base && <span className="changes-muted"> vs {br.base}</span>}
            </span>
          ) : <span className="changes-muted">{where}</span>}
          <span className="changes-spacer" />
          <div className="changes-scope-pick" ref={menuRef}>
            <button type="button" className="changes-scope-btn" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} title="What to compare">
              {label(scope)} <span aria-hidden="true">▾</span>
            </button>
            {menuOpen && (
              <div className="changes-scope-menu" role="menu">
                {items.map((it, i) => (
                  <div key={it.scope}>
                    {sessionId && i === 3 && <div className="changes-scope-sep" />}
                    <button type="button" role="menuitemradio" aria-checked={scope === it.scope}
                      disabled={noSnapshot && isSessionScope(it.scope)}
                      onClick={() => { setScope(it.scope); setMenuOpen(false); }}>
                      <span className="changes-scope-name">{label(it.scope)}{scope === it.scope && <span className="changes-scope-check" aria-hidden="true">✓</span>}</span>
                      <span className="changes-scope-detail">{it.detail}</span>
                    </button>
                  </div>
                ))}
                {sessionId && !noSnapshot && (
                  <>
                    <div className="changes-scope-sep" />
                    <button type="button" role="menuitem" onClick={() => void markSeen()} disabled={marking}>
                      <span className="changes-scope-name">Mark all changes as seen</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <button type="button" className="changes-refresh" onClick={() => { void load(); void loadPr(true); }} title="Refresh (also refreshes by itself every few seconds)" aria-label="Refresh">{loading ? '…' : '⟳'}</button>
        </div>
        <div className="changes-row changes-sub">
          {target === FOLLOW && (
            <span className="changes-follow" title="This tab follows the session you are working in">
              ↳ {follow ? follow.label : 'No session open'}{data?.worktree ? ` · worktree ${data.worktree}` : ''}
            </span>
          )}
          {(sess || br?.git) && (
            <span className="changes-stats">
              {files.length} file{files.length === 1 ? '' : 's'} <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
              {sess && repoCount > 1 && <span className="changes-muted"> · {repoCount} checkouts</span>}
              {br?.git && scope === 'base' && br.ahead > 0 && <span className="changes-muted"> · {br.ahead} commit{br.ahead === 1 ? '' : 's'}</span>}
              {br?.git && br.dirty > 0 && <span className="changes-muted"> · {br.dirty} uncommitted</span>}
            </span>
          )}
          {files.length > 1 && (
            <span className="changes-fold">
              <button type="button" onClick={() => setAll(true)}>Expand all</button>
              <button type="button" onClick={() => setAll(false)}>Collapse all</button>
            </span>
          )}
        </div>
        {noSnapshot && scope === 'base' && (
          <div className="changes-note">This session has no starting point yet, so this shows its branch. What the session changes is tracked from your next message.</div>
        )}
        {br?.git && !(pr && !pr.pr && !pr.unavailable && br.base && br.branch === br.base.replace(/^origin\//, '')) && <PrCard status={pr} onRefresh={() => void loadPr(true)} />}
        {sess && pr?.pr && <PrCard status={pr} onRefresh={() => void loadPr(true)} />}
      </div>
      <div className="changes-body" ref={bodyRef}>
        {error && <div className="changes-empty error">Could not read the changes: {error}</div>}
        {!error && !data && <div className="changes-empty">Loading…</div>}
        {br && !br.git && <div className="changes-empty">{where} is not a git repository, so there are no changes to show.</div>}
        {sess?.repos.filter((r) => r.error).map((r) => <div key={r.root} className="changes-empty error">{r.name}: {r.error}</div>)}
        {sess && files.length === 0 && (
          <div className="changes-empty">
            {scope === 'turn' ? 'Nothing changed since your last message.' : scope === 'seen' && points?.seen ? 'Nothing new since you last marked the changes seen.' : 'This session has not changed anything yet.'}
          </div>
        )}
        {br?.git && files.length === 0 && (
          <div className="changes-empty">
            No changes{scope === 'uncommitted' ? ' that are not committed' : br.base && br.branch !== br.base ? ` since ${br.base}` : ''}.
            {scope === 'base' && br.base && br.branch === br.base && <div className="changes-muted">This checkout is on {br.base} itself, so only uncommitted work would show here.</div>}
          </div>
        )}
        {files.map((f, i) => <FileDiff key={fileKey(f)} file={f} open={isOpen(f, i)} onToggle={onToggle} loadText={loadText} repoName={sess ? repoName(f.repo) : undefined} />)}
      </div>
      {onAddToChat && (
        <AddToChatSelection
          containerRef={bodyRef}
          onAddToChat={(quote) => {
            const root = bodyRef.current;
            const source = root ? diffQuoteSource(selectedRows(root)) : null;
            onAddToChat(source ? { quote, source } : { quote, origin: 'Changes' });
          }}
        />
      )}
    </div>
  );
}
