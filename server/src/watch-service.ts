import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrByNumber, readPrRef } from './changes-pr.js';
import { getWatches, listUserIds, putWatches } from './store.js';
import {
  MAX_CONCURRENT_DELIVERIES, evaluate, expiredText, nextCheckDelay, parsePrRef, prKey, THEN_MAX, timeoutMs,
  watchLabel, watchRefusal, watchReport, type PrSeen, type Watch, type WatchCondition, type Watches,
} from './watches.js';

// Model: Session.watches — the running part: keeps each user's watches on
// disk, looks at the conditions on a schedule (one look per pull request
// per tick, however many sessions wait on it), and hands a settled watch's
// report to its session through `deliver`, a few sessions at a time.

const TICK_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 30 * 60_000;

export type WatchHooks = {
  // Put `text` into the session as a message (waking it), and resolve once
  // the turn it starts has ended. Throws when the session can't take it.
  deliver: (uid: string, w: Watch, text: string) => Promise<void>;
  // The session's set of watches changed: tell its open tabs.
  changed: (uid: string, sessionId: string) => void;
};
let hooks: WatchHooks | null = null;
export function configureWatches(h: WatchHooks) { hooks = h; }

// ---- per-user edits, one at a time ----

const chains = new Map<string, Promise<unknown>>();
function edit<T>(uid: string, fn: (ws: Watches) => T): Promise<T> {
  const next = (chains.get(uid) ?? Promise.resolve()).then(async () => {
    const ws = await getWatches(uid);
    const before = JSON.stringify(ws);
    const out = fn(ws);
    if (JSON.stringify(ws) !== before) await putWatches(uid, ws);
    return out;
  });
  chains.set(uid, next.catch(() => {}));
  return next;
}

// The watches still waiting, of one session or all of the user's.
export async function watchesOf(uid: string, sessionId?: string): Promise<Watch[]> {
  const ws = await getWatches(uid).catch(() => ({} as Watches));
  return Object.values(ws).filter((w) => !w.outcome && (!sessionId || w.sessionId === sessionId)).sort((a, b) => a.createdAt - b.createdAt);
}

// ---- the server's own code ----

const SERVER_DIR = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../..');

function git(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: SERVER_DIR, timeout: 10_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0, out: String(stdout).trim() });
    });
  });
}

// The commit this server process started from: the code it runs.
let headAtStart: Promise<string> | null = null;
export function serverHead(): Promise<string> {
  headAtStart ??= git(['rev-parse', 'HEAD']).then((r) => (r.code === 0 ? r.out : ''));
  return headAtStart;
}

// Does the running code include `commit`? null: git doesn't know it.
async function serverContains(commit: string): Promise<boolean | null> {
  const head = await serverHead();
  if (!head) return null;
  const r = await git(['merge-base', '--is-ancestor', commit, head]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

// ---- adding and cancelling ----

export type WatchRequest = {
  kind: 'pr_merged' | 'pr_checks' | 'deployed';
  pr?: number;
  commit?: string;
  then?: string;
  timeoutHours?: number;
};

// Model: the watch_until tool. `cwd`: where the session works, for "the PR
// of my branch".
export async function addWatch(uid: string, who: { sessionId: string; projectId: string; projectPath: string; cwd: string }, req: WatchRequest): Promise<Watch | { error: string }> {
  let condition: WatchCondition;
  if (req.kind === 'deployed' && req.commit) {
    const commit = req.commit.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { error: `"${commit}" is not a commit hash.` };
    condition = { kind: 'deployed', commit };
  } else {
    const r = await readPrRef(who.cwd, req.pr);
    if ('error' in r) return { error: req.pr ? `Could not find PR #${req.pr}: ${r.error}` : `Could not find a pull request for the branch checked out in ${who.cwd}: ${r.error}. Pass its number as pr.` };
    const ref = parsePrRef(r.json);
    if (!ref) return { error: 'gh did not say which repository the pull request is in.' };
    condition = { kind: req.kind, repo: ref.repo, pr: ref.pr };
  }
  const now = Date.now();
  const w: Watch = {
    id: randomUUID().slice(0, 8),
    sessionId: who.sessionId,
    projectId: who.projectId,
    projectPath: who.projectPath,
    condition,
    label: watchLabel(condition),
    then: String(req.then ?? '').trim().slice(0, THEN_MAX),
    createdAt: now,
    deadline: now + timeoutMs(req.timeoutHours),
    nextCheckAt: now,
    checks: 0,
    lastSeen: 'not looked at yet',
  };
  const refusal = await edit(uid, (ws) => {
    const why = watchRefusal(Object.values(ws), who.sessionId);
    if (!why) ws[w.id] = w;
    return why;
  });
  if (refusal) return { error: refusal };
  hooks?.changed(uid, who.sessionId);
  kick();
  return w;
}

// Remove the session's watches matching `pick` (all of them without one)
// that were set before `before`. Those already settled and on their way are
// stopped too: the user's reply came first.
export async function cancelWatches(uid: string, sessionId: string, opts: { id?: string; before?: number } = {}): Promise<Watch[]> {
  const gone = await edit(uid, (ws) => {
    const out: Watch[] = [];
    for (const w of Object.values(ws)) {
      if (w.sessionId !== sessionId) continue;
      if (opts.id && w.id !== opts.id) continue;
      if (opts.before !== undefined && w.createdAt >= opts.before) continue;
      out.push(w);
      delete ws[w.id];
    }
    return out;
  }).catch(() => [] as Watch[]);
  if (gone.length > 0) hooks?.changed(uid, sessionId);
  return gone;
}

// ---- looking ----

async function lookAtPr(repo: string, pr: number): Promise<PrSeen> {
  const r = await readPrByNumber(repo, pr);
  if ('error' in r) return { error: r.error };
  if (!r.pr) return { error: 'no such pull request' };
  return { state: r.pr.state, title: r.pr.title, mergeCommit: r.mergeCommit, checks: r.pr.checks.map((c) => ({ name: c.name, state: c.state })) };
}

let ticking = false;
async function tick(opts: { all?: boolean } = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const head = await serverHead();
    // One look per pull request / commit per tick, shared by every watch.
    const prs = new Map<string, Promise<PrSeen>>();
    const contains = new Map<string, Promise<boolean | null>>();
    for (const uid of await listUserIds()) {
      const due = (await watchesOf(uid)).filter((w) => opts.all || w.nextCheckAt <= Date.now());
      if (due.length === 0) continue;
      const results = await Promise.all(due.map(async (w) => {
        const now = Date.now();
        const key = prKey(w.condition);
        let pr: PrSeen | null = null;
        if (key && w.condition.repo && w.condition.pr) {
          if (!prs.has(key)) prs.set(key, lookAtPr(w.condition.repo, w.condition.pr));
          pr = await prs.get(key)!;
        }
        let has: boolean | null = null;
        if (w.condition.kind === 'deployed') {
          const commit = w.condition.commit ?? (pr && 'mergeCommit' in pr ? pr.mergeCommit : null);
          if (commit) {
            if (!contains.has(commit)) contains.set(commit, serverContains(commit));
            has = await contains.get(commit)!;
          }
        }
        return { w, now, v: evaluate(w.condition, { pr, contains: has, serverHead: head }, now - w.createdAt) };
      }));
      const settled = await edit(uid, (ws) => {
        const out: Watch[] = [];
        for (const { w, now, v } of results) {
          const cur = ws[w.id];
          if (!cur || cur.outcome) continue; // cancelled meanwhile
          cur.checks += 1;
          cur.lastSeen = v.text;
          if (v.verdict === 'met' || v.verdict === 'failed') cur.outcome = { kind: v.verdict, text: v.text };
          else if (now >= cur.deadline) cur.outcome = { kind: 'expired', text: expiredText(cur) };
          else cur.nextCheckAt = now + nextCheckDelay(now - cur.createdAt);
          if (cur.outcome) out.push({ ...cur });
        }
        return out;
      }).catch(() => [] as Watch[]);
      for (const w of settled) { enqueue(uid, w); hooks?.changed(uid, w.sessionId); }
    }
  } finally {
    ticking = false;
  }
}

// Look at every waiting watch now, due or not (tests, and server start).
export function checkWatchesNow(): Promise<void> { return tick({ all: true }); }

// ---- delivering, a few at a time ----

const queue: { uid: string; id: string }[] = [];
const queued = new Set<string>();
let inFlight = 0;

function enqueue(uid: string, w: Watch) {
  if (queued.has(w.id)) return;
  queued.add(w.id);
  queue.push({ uid, id: w.id });
  pump();
}

function pump() {
  while (inFlight < MAX_CONCURRENT_DELIVERIES && queue.length > 0) {
    const job = queue.shift()!;
    inFlight++;
    void deliverOne(job.uid, job.id).finally(() => { inFlight--; queued.delete(job.id); pump(); });
  }
}

async function deliverOne(uid: string, id: string) {
  // Read again: the user may have replied (cancelling it) while it queued.
  const w = (await getWatches(uid).catch(() => ({} as Watches)))[id];
  if (!w?.outcome || !hooks) return;
  // Gone from the list before the session hears of it, so a turn the report
  // starts sees it settled; a crash in between loses one report at most.
  await edit(uid, (ws) => { delete ws[id]; }).catch(() => {});
  hooks.changed(uid, w.sessionId);
  const text = watchReport(w, w.outcome, w.lastSeen);
  try {
    await Promise.race([hooks.deliver(uid, w, text), new Promise((r) => setTimeout(r, DELIVERY_TIMEOUT_MS))]);
  } catch {}
}

// ---- start ----

let timer: NodeJS.Timeout | null = null;
function kick() { setTimeout(() => { void tick(); }, 500); }

// Model: server start — watches settled before a restart are delivered now;
// every other one is looked at at once (a `deployed` one is met by the very
// restart it waited for).
export async function startWatches(): Promise<number> {
  let n = 0;
  for (const uid of await listUserIds()) {
    for (const w of Object.values(await getWatches(uid).catch(() => ({} as Watches)))) if (w.outcome) { enqueue(uid, w); n++; }
  }
  await tick({ all: true });
  timer ??= setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
  return n;
}
