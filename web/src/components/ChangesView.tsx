import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChangedFile, fetchChanges, fetchPrStatus, type ChangesResult, type ChangesScope, type DiffFile, type DiffLine, type PrStatus } from '../api';
import { copyText } from '../lib/clipboard';
import { fileGaps, gapView, keepUnchangedFiles, pairWordDiffs, splitPath, type Gap, type GapOpen, type Seg } from '../lib/diffView';
import { PrCard } from './PrCard';
import type { ChatQuote } from '../lib/addToChat';
import { diffQuoteSource, statusLetter, type DiffRowRef } from '../lib/diffQuote';
import { FOLLOW, ROOT } from '../lib/sidePanel';
import { AddToChatSelection } from './CommentComposer';

// Model: web.ChangesView — the side panel's Changes tab: what a checkout
// changed since its branch left the main branch (or only what is not
// committed yet), file by file. It refreshes itself while it is on screen, so
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

const FileDiff = memo(function FileDiff({ file, open, onToggle, loadText }: {
  file: DiffFile;
  open: boolean;
  onToggle: (path: string) => void;
  // The new version on disk, for the folded stretches.
  loadText: (path: string) => Promise<string>;
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
        const ls = (await loadText(file.path)).split('\n');
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
        onClick={() => onToggle(file.path)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(file.path); } }}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <span className="diff-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={`diff-status s-${file.status}`} title={file.status}>{statusLetter(file.status)}</span>
        <span className="diff-path">
          <span className="diff-name">{name}</span>
          {(dir || file.oldPath) && <span className="diff-dir">{file.oldPath ? `from ${file.oldPath}` : dir}</span>}
        </span>
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
  const [scope, setScope] = useState<ChangesScope>('base');
  const [data, setData] = useState<ChangesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Files the user folded or unfolded; the rest follow the default.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pr, setPr] = useState<PrStatus | null>(null);

  const query = useMemo(() => {
    if (target === FOLLOW) return { worktree: follow?.worktree ?? null, session: follow?.sessionId ?? null };
    if (target === ROOT) return { worktree: null, session: null };
    return { worktree: target, session: null };
  }, [target, follow?.worktree, follow?.sessionId]);
  const key = `${projectId}|${query.worktree ?? ''}|${query.session ?? ''}|${scope}`;

  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (inflight.current) return;
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    try {
      const r = await fetchChanges(projectId, { ...query, scope }, ac.signal);
      if (!ac.signal.aborted) { setData((prev) => keepUnchangedFiles(prev, r)); setError(null); }
    } catch (e) {
      if (!ac.signal.aborted) setError(String((e as Error).message ?? e));
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
  const branch = data?.git ? data.branch : null;
  useEffect(() => { if (active && branch && pr && pr.branch !== undefined && pr.branch !== branch) void loadPr(); }, [active, branch, pr, loadPr]);

  // A different checkout or scope: start over.
  useEffect(() => {
    inflight.current?.abort();
    inflight.current = null;
    setData(null);
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

  const loadText = useCallback((p: string) => fetchChangedFile(projectId, { ...query, path: p }), [projectId, query]);

  const files = data?.git ? data.files : [];
  const isOpen = (f: DiffFile, i: number) => toggled.get(f.path) ?? (i < OPEN_FILE_LIMIT && lineCount(f) <= OPEN_LINE_LIMIT);
  const onToggle = useCallback((path: string) => {
    setToggled((prev) => {
      const i = files.findIndex((f) => f.path === path);
      const cur = prev.get(path) ?? (i < OPEN_FILE_LIMIT && i >= 0 && lineCount(files[i]) <= OPEN_LINE_LIMIT);
      return new Map(prev).set(path, !cur);
    });
  }, [files]);
  const setAll = (open: boolean) => setToggled(new Map(files.map((f) => [f.path, open])));

  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const where = data?.worktree ? `worktree ${data.worktree}` : projectName;

  return (
    <div className="changes">
      <div className="changes-head">
        <div className="changes-row">
          {data?.git ? (
            <span className="changes-branch" title={data.mergeBase ? `${data.branch}, compared with ${data.base} at ${data.mergeBase.slice(0, 8)}` : data.branch}>
              <b>{data.branch}</b>
              {scope === 'base' && data.base && data.branch !== data.base && <span className="changes-muted"> vs {data.base}</span>}
            </span>
          ) : <span className="changes-muted">{where}</span>}
          <span className="changes-spacer" />
          <div className="changes-scope" role="group" aria-label="Compare with">
            <button type="button" className={scope === 'base' ? 'on' : ''} onClick={() => setScope('base')} title="Everything since this branch left the main branch: commits and uncommitted work">Since {data?.git && data.base ? data.base.replace(/^origin\//, '') : 'main'}</button>
            <button type="button" className={scope === 'uncommitted' ? 'on' : ''} onClick={() => setScope('uncommitted')} title="Only what is not committed yet">Uncommitted</button>
          </div>
          <button type="button" className="changes-refresh" onClick={() => { void load(); void loadPr(true); }} title="Refresh (also refreshes by itself every few seconds)" aria-label="Refresh">{loading ? '…' : '⟳'}</button>
        </div>
        <div className="changes-row changes-sub">
          {target === FOLLOW && (
            <span className="changes-follow" title="This tab follows the session you are working in">
              ↳ {follow ? follow.label : 'No session open'}{data?.worktree ? ` · worktree ${data.worktree}` : ''}
            </span>
          )}
          {data?.git && (
            <span className="changes-stats">
              {files.length} file{files.length === 1 ? '' : 's'} <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
              {scope === 'base' && data.ahead > 0 && <span className="changes-muted"> · {data.ahead} commit{data.ahead === 1 ? '' : 's'}</span>}
              {data.dirty > 0 && <span className="changes-muted"> · {data.dirty} uncommitted</span>}
            </span>
          )}
          {files.length > 1 && (
            <span className="changes-fold">
              <button type="button" onClick={() => setAll(true)}>Expand all</button>
              <button type="button" onClick={() => setAll(false)}>Collapse all</button>
            </span>
          )}
        </div>
        {data?.git && !(pr && !pr.pr && !pr.unavailable && data.base && data.branch === data.base.replace(/^origin\//, '')) && <PrCard status={pr} onRefresh={() => void loadPr(true)} />}
      </div>
      <div className="changes-body" ref={bodyRef}>
        {error && <div className="changes-empty error">Could not read the changes: {error}</div>}
        {!error && !data && <div className="changes-empty">Loading…</div>}
        {data && !data.git && <div className="changes-empty">{where} is not a git repository, so there are no changes to show.</div>}
        {data?.git && files.length === 0 && (
          <div className="changes-empty">
            No changes{scope === 'uncommitted' ? ' that are not committed' : data.base && data.branch !== data.base ? ` since ${data.base}` : ''}.
            {scope === 'base' && data.base && data.branch === data.base && <div className="changes-muted">This checkout is on {data.base} itself, so only uncommitted work would show here.</div>}
          </div>
        )}
        {files.map((f, i) => <FileDiff key={f.path} file={f} open={isOpen(f, i)} onToggle={onToggle} loadText={loadText} />)}
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
