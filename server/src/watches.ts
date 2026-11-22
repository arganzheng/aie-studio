import type { CheckState } from './changes-pr.js';

// Model: Session.watches — conditions a Claude session is waiting on that the
// server can check for it (a pull request merged, its CI checks finished, a
// change deployed to this server), so it doesn't have to wait for the user to
// say so. The session ends its turn as usual — still waiting for the user —
// and whichever comes first carries the work on: the user's reply (which ends
// the session's watches) or the watch being met (a message in its
// conversation, as if the user had replied). This file is the pure part:
// conditions, verdicts, schedule, limits and the wording the agent sees.
// watch-service.ts runs them.

export type WatchCondition =
  | { kind: 'pr_merged'; repo: string; pr: number }
  | { kind: 'pr_checks'; repo: string; pr: number }
  // This aie-studio server runs code that includes `commit`, or the merge
  // commit of `repo`#`pr` once it is merged.
  | { kind: 'deployed'; commit?: string; repo?: string; pr?: number };

export type WatchOutcome = { kind: 'met' | 'failed' | 'expired'; text: string };

export type Watch = {
  id: string;
  sessionId: string;
  projectId: string;
  projectPath: string;
  condition: WatchCondition;
  label: string;
  // What the agent said it will do once the condition is met.
  then: string;
  createdAt: number;
  deadline: number;
  nextCheckAt: number;
  checks: number;
  // The last observation, in a few words (list_watches, the UI).
  lastSeen: string;
  // Set once settled: the report is on its way to the session.
  outcome?: WatchOutcome;
};

// Per user, keyed by watch id.
export type Watches = Record<string, Watch>;

export const MAX_WATCHES_PER_SESSION = 5;
export const MAX_WATCHES_PER_USER = 50;
export const DEFAULT_TIMEOUT_HOURS = 24;
export const MAX_TIMEOUT_HOURS = 7 * 24;
// Sessions woken by watches at the same time; the rest wait their turn.
export const MAX_CONCURRENT_DELIVERIES = 3;
// A PR with no checks yet may just not have had them registered.
export const NO_CHECKS_GRACE_MS = 3 * 60_000;
export const THEN_MAX = 500;

export const WATCH_REPORT_PREFIX = '[Watch "';

const MIN = 60_000;

// How long until the next look: often at first, then less and less, so a
// long wait doesn't spend the GitHub API allowance.
export function nextCheckDelay(ageMs: number): number {
  if (ageMs < 10 * MIN) return 30_000;
  if (ageMs < 60 * MIN) return 2 * MIN;
  return 10 * MIN;
}

const short = (sha: string) => sha.slice(0, 7);

export function watchLabel(c: WatchCondition): string {
  if (c.kind === 'pr_merged') return `PR #${c.pr} merged`;
  if (c.kind === 'pr_checks') return `PR #${c.pr} checks done`;
  return c.pr ? `PR #${c.pr} deployed` : `${short(c.commit ?? '')} deployed`;
}

// The pull request the watches of one tick share a look at.
export function prKey(c: WatchCondition): string | null {
  return c.repo && c.pr ? `${c.repo}#${c.pr}` : null;
}

// Pure: the timeout asked for, in ms, kept within bounds.
export function timeoutMs(hours: unknown): number {
  const h = typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? Math.min(hours, MAX_TIMEOUT_HOURS) : DEFAULT_TIMEOUT_HOURS;
  return Math.round(h * 60 * MIN);
}

// Pure: why a new watch can't be added, or null.
export function watchRefusal(all: readonly Watch[], sessionId: string): string | null {
  const live = all.filter((w) => !w.outcome);
  if (live.filter((w) => w.sessionId === sessionId).length >= MAX_WATCHES_PER_SESSION) {
    return `This session already has ${MAX_WATCHES_PER_SESSION} watches. Cancel one you no longer need (list_watches, cancel_watch) first.`;
  }
  if (live.length >= MAX_WATCHES_PER_USER) return `The user already has ${MAX_WATCHES_PER_USER} watches across their sessions; no more can be added now.`;
  return null;
}

// What one look at a pull request found. `error`: gh could not be asked
// (a passing problem as far as a watch goes: it looks again later).
export type PrSeen =
  | { state: 'open' | 'draft' | 'merged' | 'closed'; title: string; mergeCommit: string | null; checks: { name: string; state: CheckState }[] }
  | { error: string };

export type Verdict = { verdict: 'met' | 'failed' | 'waiting'; text: string };

function checksSummary(checks: { name: string; state: CheckState }[]): string {
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  const parts = [`${n('pass')} passed`, n('fail') ? `${n('fail')} failed (${checks.filter((c) => c.state === 'fail').map((c) => c.name).join(', ')})` : '', n('skipped') ? `${n('skipped')} skipped` : '', n('pending') ? `${n('pending')} running` : ''];
  return parts.filter(Boolean).join(', ');
}

// Pure: where a watch stands, given what was seen. `contains`: whether this
// server's code includes the commit a `deployed` watch waits for (null:
// unknown commit, e.g. not fetched yet).
export function evaluate(c: WatchCondition, seen: { pr?: PrSeen | null; contains?: boolean | null; serverHead?: string }, ageMs: number): Verdict {
  const pr = seen.pr;
  if (pr && 'error' in pr) return { verdict: 'waiting', text: `could not ask GitHub: ${pr.error}` };
  const name = c.pr ? `PR #${c.pr}${pr && 'title' in pr && pr.title ? ` "${pr.title}"` : ''}` : '';
  if (c.kind === 'pr_merged') {
    if (!pr) return { verdict: 'waiting', text: 'not looked at yet' };
    if (pr.state === 'merged') return { verdict: 'met', text: `${name} was merged${pr.mergeCommit ? ` (merge commit ${short(pr.mergeCommit)})` : ''}.` };
    if (pr.state === 'closed') return { verdict: 'failed', text: `${name} was closed without being merged.` };
    return { verdict: 'waiting', text: `${pr.state}${pr.checks.length ? `, checks: ${checksSummary(pr.checks)}` : ''}` };
  }
  if (c.kind === 'pr_checks') {
    if (!pr) return { verdict: 'waiting', text: 'not looked at yet' };
    const running = pr.checks.filter((x) => x.state === 'pending').length;
    if (pr.checks.length === 0) {
      if (pr.state === 'closed') return { verdict: 'failed', text: `${name} was closed without being merged, and it has no checks.` };
      if (ageMs < NO_CHECKS_GRACE_MS && pr.state !== 'merged') return { verdict: 'waiting', text: 'no checks reported yet' };
      return { verdict: 'met', text: `${name} has no CI checks.` };
    }
    if (running === 0) return { verdict: 'met', text: `The checks of ${name} have finished: ${checksSummary(pr.checks)}.` };
    if (pr.state === 'closed') return { verdict: 'failed', text: `${name} was closed with checks still running.` };
    return { verdict: 'waiting', text: `checks: ${checksSummary(pr.checks)}` };
  }
  // deployed
  if (c.pr) {
    if (!pr) return { verdict: 'waiting', text: 'not looked at yet' };
    if (pr.state === 'closed') return { verdict: 'failed', text: `${name} was closed without being merged, so it will not be deployed.` };
    if (pr.state !== 'merged' || !pr.mergeCommit) return { verdict: 'waiting', text: `${name} is not merged yet` };
  }
  const commit = c.commit ?? (pr && 'mergeCommit' in pr ? pr.mergeCommit : null) ?? '';
  const head = seen.serverHead ? short(seen.serverHead) : 'unknown';
  if (seen.contains === true) return { verdict: 'met', text: `This aie-studio server is now running code that includes ${name ? `${name} (${short(commit)})` : short(commit)}: it was restarted at ${head}.` };
  return { verdict: 'waiting', text: `the server runs ${head}, which does not include ${short(commit)} yet` };
}

// Pure: the message a settled watch puts into its session's conversation.
export function watchReport(w: Pick<Watch, 'label' | 'then' | 'createdAt'>, o: WatchOutcome, lastSeen = ''): string {
  if (o.kind === 'met') {
    return [
      `${WATCH_REPORT_PREFIX}${w.label}" met]`,
      o.text,
      w.then ? `When you set this watch you planned to: ${w.then}` : '',
      'The user has not replied since: treat this as their go-ahead and carry on. Stop to ask only for a decision that is really theirs.',
    ].filter(Boolean).join('\n\n');
  }
  if (o.kind === 'failed') {
    return [
      `${WATCH_REPORT_PREFIX}${w.label}" cannot be met]`,
      o.text,
      w.then ? `You had planned, once it was met, to: ${w.then}` : '',
      'Decide what to do: if you can put it right yourself, do so and carry on; otherwise tell the user what happened.',
    ].filter(Boolean).join('\n\n');
  }
  return [
    `${WATCH_REPORT_PREFIX}${w.label}" timed out]`,
    o.text,
    lastSeen ? `Last seen: ${lastSeen}.` : '',
    'Tell the user where things stand. Set a new watch if waiting longer makes sense.',
  ].filter(Boolean).join('\n\n');
}

export function expiredText(w: Pick<Watch, 'createdAt' | 'deadline'>): string {
  const h = Math.round((w.deadline - w.createdAt) / (60 * MIN));
  return `Nothing settled it within ${h} hour${h === 1 ? '' : 's'}.`;
}

// Given to the agent as the instructions of the watch tools' MCP server.
export const WATCH_INSTRUCTIONS = [
  'Watches. When you are waiting on something you can check yourself — a pull request being merged, its CI checks finishing, a change being deployed to this aie-studio server — call watch_until before you end your turn, instead of asking the user to tell you when it has happened.',
  'Then end your turn as usual (with a needs-you status line if you also want the user\'s say). Whichever comes first carries the work on: the user\'s reply, which ends your watches (set one again if you still need it), or the watch\'s report, a message starting with "[Watch".',
  'Treat a met watch as the user\'s go-ahead: carry on with what you planned, and stop only for decisions that are really the user\'s. Do not sleep or poll for these yourself.',
].join(' ');

// ---- on disk -----------------------------------------------------------

function cleanCondition(c: any): WatchCondition | null {
  if (!c || typeof c !== 'object') return null;
  const repo = typeof c.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(c.repo) ? c.repo : undefined;
  const pr = Number.isInteger(c.pr) && c.pr > 0 ? c.pr as number : undefined;
  const commit = typeof c.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(c.commit) ? c.commit : undefined;
  if (c.kind === 'pr_merged' || c.kind === 'pr_checks') return repo && pr ? { kind: c.kind, repo, pr } : null;
  if (c.kind === 'deployed') {
    if (commit) return { kind: 'deployed', commit };
    return repo && pr ? { kind: 'deployed', repo, pr } : null;
  }
  return null;
}

export function normalizeWatches(raw: unknown): Watches {
  const out: Watches = {};
  if (!raw || typeof raw !== 'object') return out;
  const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v !== 'object' || !str(v.sessionId) || !str(v.projectId) || !str(v.projectPath)) continue;
    const condition = cleanCondition(v.condition);
    if (!condition) continue;
    const o = v.outcome;
    out[id] = {
      id,
      sessionId: v.sessionId,
      projectId: v.projectId,
      projectPath: v.projectPath,
      condition,
      label: str(v.label) || watchLabel(condition),
      then: str(v.then).slice(0, THEN_MAX),
      createdAt: num(v.createdAt),
      deadline: num(v.deadline),
      nextCheckAt: num(v.nextCheckAt),
      checks: num(v.checks),
      lastSeen: str(v.lastSeen),
      ...(o && typeof o === 'object' && ['met', 'failed', 'expired'].includes(o.kind) ? { outcome: { kind: o.kind, text: str(o.text) } } : {}),
    };
  }
  return out;
}

// Pure: the PR a `gh pr view --json number,url` answer names.
export function parsePrRef(j: any): { repo: string; pr: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(String(j?.url ?? ''));
  if (!m || typeof j?.number !== 'number') return null;
  return { repo: m[1], pr: j.number };
}

// What the UI shows for a session's watches.
export type WatchView = { id: string; label: string; createdAt: number; deadline: number; lastSeen: string };
export function watchView(w: Watch): WatchView {
  return { id: w.id, label: w.label, createdAt: w.createdAt, deadline: w.deadline, lastSeen: w.lastSeen };
}
