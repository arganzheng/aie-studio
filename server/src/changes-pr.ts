import { execFile } from 'node:child_process';

// Model: web.ChangesView "pull request" — the pull request of the branch a
// checkout is on, and how its CI checks stand, as GitHub's `gh` CLI reports
// them. Read with the user's own `gh` login; nothing is stored.

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';
export type PrCheck = { name: string; workflow: string; state: CheckState; url: string | null };
export type PrInfo = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  // GitHub's review decision ('' when the repository asks for none).
  review: 'approved' | 'changes-requested' | 'review-required' | '';
  // Can it merge cleanly; 'unknown' while GitHub is still working it out.
  mergeable: 'yes' | 'conflicts' | 'unknown';
  base: string;
  head: string;
  checks: PrCheck[];
};
// pr null = gh answered: this branch has no pull request. unavailable: gh
// could not be asked (not installed, not logged in, not a GitHub remote).
export type PrStatus = { pr: PrInfo | null; unavailable?: string };

const FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeable,baseRefName,headRefName,statusCheckRollup';

function checkState(c: any): CheckState {
  if (c?.__typename === 'StatusContext') {
    const s = String(c.state ?? '').toUpperCase();
    return s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'pending';
  }
  if (String(c?.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending';
  const k = String(c?.conclusion ?? '').toUpperCase();
  if (k === 'SUCCESS') return 'pass';
  if (k === 'SKIPPED' || k === 'NEUTRAL') return 'skipped';
  return 'fail'; // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
}

const RANK: Record<CheckState, number> = { fail: 0, pending: 1, pass: 2, skipped: 3 };

// Pure: gh's JSON → PrInfo. A check run again keeps its latest run only;
// failed checks come first, then running, passed, skipped.
export function parsePr(j: any): PrInfo | null {
  if (!j || typeof j.number !== 'number') return null;
  const latest = new Map<string, { c: any; at: string }>();
  for (const c of Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : []) {
    const name = String(c?.name ?? c?.context ?? '').trim();
    if (!name) continue;
    const key = `${c?.workflowName ?? ''}\u0000${name}`;
    const at = String(c?.startedAt ?? c?.completedAt ?? c?.createdAt ?? '');
    const cur = latest.get(key);
    if (!cur || at >= cur.at) latest.set(key, { c, at });
  }
  const checks: PrCheck[] = [...latest.values()].map(({ c }) => ({
    name: String(c.name ?? c.context),
    workflow: String(c.workflowName ?? ''),
    state: checkState(c),
    url: typeof c.detailsUrl === 'string' && c.detailsUrl ? c.detailsUrl : typeof c.targetUrl === 'string' && c.targetUrl ? c.targetUrl : null,
  }));
  checks.sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name));
  const st = String(j.state ?? '').toUpperCase();
  const review = String(j.reviewDecision ?? '').toUpperCase();
  const m = String(j.mergeable ?? '').toUpperCase();
  return {
    number: j.number,
    title: String(j.title ?? ''),
    url: String(j.url ?? ''),
    state: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open',
    review: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes-requested' : review === 'REVIEW_REQUIRED' ? 'review-required' : '',
    mergeable: m === 'MERGEABLE' ? 'yes' : m === 'CONFLICTING' ? 'conflicts' : 'unknown',
    base: String(j.baseRefName ?? ''),
    head: String(j.headRefName ?? ''),
    checks,
  };
}

// Pure: what gh's error output means for the user.
export function ghProblem(stderr: string): PrStatus {
  const s = stderr.toLowerCase();
  if (/no (open )?pull requests? found/.test(s)) return { pr: null };
  if (s.includes('enoent') || s.includes('not found: gh') || s.includes('command not found')) return { pr: null, unavailable: 'The GitHub CLI (gh) is not installed on the server' };
  if (s.includes('gh auth login') || s.includes('not logged')) return { pr: null, unavailable: 'The GitHub CLI (gh) is not logged in on the server — run `gh auth login`' };
  if (s.includes('known github host') || s.includes('no git remotes')) return { pr: null, unavailable: 'This checkout has no GitHub remote' };
  return { pr: null, unavailable: stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'gh failed' };
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<PrStatus> }>();

function runGh(dir: string): Promise<PrStatus> {
  const bin = process.env.AIE_GH_BIN || 'gh';
  return new Promise((resolve) => {
    execFile(bin, ['pr', 'view', '--json', FIELDS], { cwd: dir, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) { resolve(ghProblem(`${stderr || ''}\n${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : err.message}`)); return; }
      try { resolve({ pr: parsePr(JSON.parse(stdout)) }); } catch { resolve({ pr: null, unavailable: 'gh answered something unreadable' }); }
    });
  });
}

// The pull request of the branch checked out in `dir` (keyed by branch, so
// a checkout that switches branch asks again). Answers are kept 30 s;
// `fresh` asks gh again.
export function readPrStatus(dir: string, branch: string, fresh = false): Promise<PrStatus> {
  const key = `${dir}\u0000${branch}`;
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = runGh(dir);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return value;
}

// ---- by number (model: Session.watches) ----

function runGhJson(args: string[], cwd: string | undefined): Promise<{ json: any } | { error: string }> {
  const bin = process.env.AIE_GH_BIN || 'gh';
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) {
        const p = ghProblem(`${stderr || ''}\n${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : err.message}`);
        resolve({ error: p.unavailable ?? 'no pull request found' });
        return;
      }
      try { resolve({ json: JSON.parse(stdout) }); } catch { resolve({ error: 'gh answered something unreadable' }); }
    });
  });
}

// The pull request `pr` (or, without one, that of the branch checked out in
// `dir`): its number and its repository's URL.
export function readPrRef(dir: string, pr?: number): Promise<{ json: any } | { error: string }> {
  return runGhJson(['pr', 'view', ...(pr ? [String(pr)] : []), '--json', 'number,url'], dir);
}

const byNumberCache = new Map<string, { at: number; value: Promise<{ pr: PrInfo | null; mergeCommit: string | null } | { error: string }> }>();

// Pull request `pr` of `repo` (owner/name), wherever the server runs: a
// watch outlives the checkout that set it. Answers are kept 30 s.
export function readPrByNumber(repo: string, pr: number): Promise<{ pr: PrInfo | null; mergeCommit: string | null } | { error: string }> {
  const key = `${repo}#${pr}`;
  const hit = byNumberCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = runGhJson(['pr', 'view', String(pr), '--repo', repo, '--json', `${FIELDS},mergeCommit`], undefined).then((r) =>
    'error' in r ? r : { pr: parsePr(r.json), mergeCommit: typeof r.json?.mergeCommit?.oid === 'string' ? r.json.mergeCommit.oid : null });
  byNumberCache.set(key, { at: Date.now(), value });
  if (byNumberCache.size > 200) byNumberCache.delete(byNumberCache.keys().next().value!);
  return value;
}

// Tests: forget what was read.
export function clearPrCache() { cache.clear(); byNumberCache.clear(); }
