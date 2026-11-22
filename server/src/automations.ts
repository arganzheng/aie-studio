import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getUserId } from './auth.js';
import { cronMatches, describeCron, nextRun, parseCron } from './cron.js';
import { getAutomationsRaw, getProject, listUserIds, putAutomationsRaw } from './store.js';
import { sendToSession, startDetachedSession } from './sdk-session.js';
import { cancelWatches, lookAtPr, onWatchDelivered, onWatchTick, serverContains, serverHead, watchesOf } from './watch-service.js';
import { evaluate, MAX_TIMEOUT_HOURS, nextCheckDelay, watchLabel, type PrSeen, type WatchCondition } from './watches.js';

// Model: Automation — "when <trigger>, do <action>", run by the server on
// its own. Triggers: a schedule (cron, server local time), a webhook (a
// secret URL anything can POST to), or a condition the server checks — a
// pull request merged, its CI checks finished, or it (or a commit) deployed
// to this server — which fires once and then turns itself off. Conditions
// are the ones of Session.watches (watches.ts), looked at on the same timer;
// watches are what an agent sets for its own session, automations what the
// user sets. Messages into a session go through the same queue as the
// watches' reports, and the watches' deliveries show in the same run list. Actions: open a new Claude session in a
// project with a prompt (optionally in its own worktree), or send the prompt
// to an existing session. Every run is recorded with the session it started
// or wrote to; "Run now" runs one by hand. A run is an ordinary session: it
// shows in the Sessions list and alerts (push included) when it ends.
//
// The prompt may contain {{body}} (the webhook's request body, or what a
// condition saw) and {{date}} (the run's local date and time). A body with
// no {{body}} in the prompt is added after it.

export type ConditionKind = 'pr_merged' | 'pr_checks' | 'deployed';
export type Trigger =
  | { kind: 'schedule'; cron: string }
  | { kind: 'webhook'; token: string }
  // armedAt: when it started waiting (creation, or turned on again).
  | { kind: 'condition'; on: ConditionKind; repo?: string; pr?: number; commit?: string; timeoutHours: number; armedAt: number };
export type Action =
  | { kind: 'new-session'; projectId: string; model?: string; worktree?: boolean }
  | { kind: 'message'; projectId: string; sessionId: string };
export type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  action: Action;
  prompt: string;
  createdAt: number;
};
export type RunSource = 'schedule' | 'webhook' | 'manual' | 'condition' | 'watch';
export type AutomationRun = {
  id: string;
  automationId: string;
  name: string;
  at: number;
  source: RunSource;
  ok: boolean;
  projectId: string;
  sessionId: string | null;
  error?: string;
};
type Stored = { automations: Automation[]; runs: AutomationRun[] };

export const MAX_AUTOMATIONS = 50;
export const MAX_RUNS = 200;
export const MAX_PROMPT = 20_000;
export const MAX_BODY = 20_000;
// A webhook firing faster than this is turned away (429).
export const WEBHOOK_MIN_GAP_MS = 5_000;

const newToken = () => randomBytes(18).toString('base64url');

// Pure: "owner/repo#12" or a pull request URL → repo and number.
export function parsePrInput(text: string): { repo: string; pr: number } | null {
  const t = text.trim();
  const url = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(t);
  if (url) return { repo: url[1], pr: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t);
  return short ? { repo: short[1], pr: Number(short[2]) } : null;
}

export function conditionOf(t: Extract<Trigger, { kind: 'condition' }>): WatchCondition {
  if (t.on === 'deployed') return { kind: 'deployed', ...(t.commit ? { commit: t.commit } : { repo: t.repo, pr: t.pr }) };
  return { kind: t.on, repo: t.repo!, pr: t.pr! };
}

// Pure: an automation as the client sent it (or as stored), cleaned; an
// error says what is wrong with it.
export function cleanAutomation(raw: any, prev?: Automation): Automation | { error: string } {
  const name = String(raw?.name ?? '').trim().slice(0, 80);
  if (!name) return { error: 'Give it a name' };
  const prompt = String(raw?.prompt ?? '').slice(0, MAX_PROMPT);
  if (!prompt.trim()) return { error: 'Write the prompt it sends' };
  let trigger: Trigger;
  if (raw?.trigger?.kind === 'webhook') {
    trigger = { kind: 'webhook', token: prev?.trigger.kind === 'webhook' ? prev.trigger.token : typeof raw.trigger.token === 'string' && raw.trigger.token.length >= 16 ? raw.trigger.token : newToken() };
  } else if (raw?.trigger?.kind === 'schedule') {
    const cron = String(raw.trigger.cron ?? '').trim();
    try { parseCron(cron); } catch (e) { return { error: `Schedule: ${(e as Error).message}` }; }
    trigger = { kind: 'schedule', cron };
  } else if (raw?.trigger?.kind === 'condition') {
    const on: ConditionKind = raw.trigger.on === 'pr_checks' ? 'pr_checks' : raw.trigger.on === 'deployed' ? 'deployed' : 'pr_merged';
    const commit = on === 'deployed' && /^[0-9a-f]{7,40}$/i.test(String(raw.trigger.commit ?? '').trim()) ? String(raw.trigger.commit).trim() : undefined;
    const ref = typeof raw.trigger.ref === 'string' ? parsePrInput(raw.trigger.ref)
      : typeof raw.trigger.repo === 'string' && Number(raw.trigger.pr) > 0 ? { repo: raw.trigger.repo, pr: Number(raw.trigger.pr) } : null;
    if (!commit && !ref) return { error: 'Give the pull request as owner/repo#12 or its URL' + (on === 'deployed' ? ', or a commit' : '') };
    const hours = Math.min(MAX_TIMEOUT_HOURS, Math.max(1, Number(raw.trigger.timeoutHours) || 72));
    const prevC = prev?.trigger.kind === 'condition' ? prev.trigger : null;
    const same = prevC && prevC.on === on && prevC.repo === ref?.repo && prevC.pr === ref?.pr && prevC.commit === commit;
    // Waiting starts again when the condition changes or it is turned back on.
    const rearm = !same || (prev && !prev.enabled && raw?.enabled !== false);
    trigger = { kind: 'condition', on, ...(commit ? { commit } : { repo: ref!.repo, pr: ref!.pr }), timeoutHours: hours, armedAt: rearm || !prevC ? Date.now() : prevC.armedAt };
  } else return { error: 'Pick a trigger: a schedule, a webhook or a condition' };
  const projectId = String(raw?.action?.projectId ?? '').trim();
  if (!projectId) return { error: 'Pick a project' };
  let action: Action;
  if (raw?.action?.kind === 'message') {
    const sessionId = String(raw.action.sessionId ?? '').trim();
    if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return { error: 'Pick the session to write to' };
    action = { kind: 'message', projectId, sessionId };
  } else {
    const model = String(raw?.action?.model ?? '').trim().slice(0, 80);
    action = { kind: 'new-session', projectId, ...(model ? { model } : {}), ...(raw?.action?.worktree === true ? { worktree: true } : {}) };
  }
  return {
    id: prev?.id ?? (typeof raw?.id === 'string' && raw.id ? raw.id : randomUUID()),
    name,
    enabled: raw?.enabled !== false,
    trigger,
    action,
    prompt,
    createdAt: prev?.createdAt ?? (Number(raw?.createdAt) || Date.now()),
  };
}

function normalize(raw: any): Stored {
  const automations = (Array.isArray(raw?.automations) ? raw.automations : [])
    .map((a: any) => cleanAutomation(a, undefined))
    .filter((a: any): a is Automation => !('error' in a));
  const runs = (Array.isArray(raw?.runs) ? raw.runs : []).filter((r: any) => r && typeof r.id === 'string').slice(-MAX_RUNS);
  return { automations, runs };
}

// Pure: what the run sends.
export function renderPrompt(prompt: string, o: { body?: string | null; now: Date; label?: string }): string {
  const date = o.now.toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  const body = (o.body ?? '').slice(0, MAX_BODY);
  let out = prompt.replace(/\{\{\s*date\s*\}\}/g, date);
  if (/\{\{\s*body\s*\}\}/.test(out)) out = out.replace(/\{\{\s*body\s*\}\}/g, body);
  else if (body.trim()) out = `${out}\n\n---\n${o.label ?? 'Webhook payload'}:\n\`\`\`\n${body}\n\`\`\``;
  return out;
}

// One write at a time per user.
const locks = new Map<string, Promise<unknown>>();
async function edit<T>(uid: string, fn: (s: Stored) => T | Promise<T>): Promise<T> {
  const prev = locks.get(uid) ?? Promise.resolve();
  let out!: T;
  const next = prev.catch(() => {}).then(async () => {
    const s = normalize(await getAutomationsRaw(uid));
    out = await fn(s);
    await putAutomationsRaw(uid, s);
  });
  locks.set(uid, next);
  await next;
  return out;
}
async function read(uid: string): Promise<Stored> { return normalize(await getAutomationsRaw(uid)); }

const lastWebhook = new Map<string, number>();

export async function runAutomation(uid: string, a: Automation, source: RunSource, body?: string | null): Promise<AutomationRun> {
  const run: AutomationRun = { id: randomUUID(), automationId: a.id, name: a.name, at: Date.now(), source, ok: false, projectId: a.action.projectId, sessionId: null };
  try {
    const project = await getProject(uid, a.action.projectId);
    if (!project) throw new Error('Its project is gone');
    const text = renderPrompt(a.prompt, { body, now: new Date(), label: source === 'condition' ? 'What happened' : 'Webhook payload' });
    if (a.action.kind === 'new-session') {
      const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(5, 16);
      const r = await startDetachedSession({ uid, projectId: project.id, projectPath: project.path, prompt: text, title: `⏱ ${a.name} · ${stamp}`, model: a.action.model, worktree: a.action.worktree });
      if (!r.sessionId) throw new Error('The session did not start (no id from claude)');
      run.sessionId = r.sessionId;
    } else {
      const r = await sendToSession({ uid, projectId: project.id, projectPath: project.path, sessionId: a.action.sessionId, text });
      if (!r.ok) throw new Error(r.error ?? 'Could not write to the session');
      run.sessionId = a.action.sessionId;
    }
    run.ok = true;
  } catch (e) {
    run.error = String((e as Error).message ?? e).slice(0, 300);
  }
  await edit(uid, (s) => { s.runs.push(run); s.runs = s.runs.slice(-MAX_RUNS); });
  return run;
}

function view(a: Automation, now: Date) {
  let next: number | null = null;
  let schedule: string | null = null;
  let condition: string | null = null;
  let lastSeen: string | null = null;
  if (a.trigger.kind === 'schedule') {
    schedule = describeCron(a.trigger.cron);
    try { next = a.enabled ? nextRun(parseCron(a.trigger.cron), now)?.getTime() ?? null : null; } catch {}
  } else if (a.trigger.kind === 'condition') {
    const c = conditionOf(a.trigger);
    condition = `${watchLabel(c)}${c.repo ? ` (${c.repo})` : ''}`;
    lastSeen = looks.get(a.id)?.lastSeen ?? null;
  }
  return { ...a, schedule, nextRunAt: next, condition, lastSeen };
}

// ---- the scheduler: every 20 s, each enabled schedule due this minute ----

const fired = new Map<string, string>(); // automation id → the minute it last fired
// Condition automations: when to look next, and what was seen last.
const looks = new Map<string, { nextAt: number; lastSeen: string }>();
export function minuteKey(d: Date): string { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`; }

async function tick(log: (msg: string) => void) {
  const now = new Date();
  const key = minuteKey(now);
  for (const uid of await listUserIds()) {
    let s: Stored;
    try { s = await read(uid); } catch { continue; }
    for (const a of s.automations) {
      if (a.enabled && a.trigger.kind === 'condition') { await lookAtCondition(uid, a, log); continue; }
      if (!a.enabled || a.trigger.kind !== 'schedule' || fired.get(a.id) === key) continue;
      let due = false;
      try { due = cronMatches(parseCron(a.trigger.cron), now); } catch {}
      if (!due) continue;
      fired.set(a.id, key);
      log(`automation "${a.name}" runs (schedule ${a.trigger.cron})`);
      void runAutomation(uid, a, 'schedule').then((r) => { if (!r.ok) log(`automation "${a.name}" failed: ${r.error}`); });
    }
  }
}

async function lookAtCondition(uid: string, a: Automation, log: (msg: string) => void) {
  if (a.trigger.kind !== 'condition') return;
  const now = Date.now();
  const st = looks.get(a.id);
  if (st && now < st.nextAt) return;
  const t = a.trigger;
  const c = conditionOf(t);
  const off = async (run?: AutomationRun) => {
    await edit(uid, (s) => { const x = s.automations.find((y) => y.id === a.id); if (x) x.enabled = false; if (run) { s.runs.push(run); s.runs = s.runs.slice(-MAX_RUNS); } });
    looks.delete(a.id);
  };
  if (now > t.armedAt + t.timeoutHours * 3600_000) {
    log(`automation "${a.name}" gave up waiting (${watchLabel(c)})`);
    await off({ id: randomUUID(), automationId: a.id, name: a.name, at: now, source: 'condition', ok: false, projectId: a.action.projectId, sessionId: null, error: `Gave up after ${t.timeoutHours} h: ${st?.lastSeen ?? watchLabel(c)}` });
    return;
  }
  let pr: PrSeen | null = null;
  if (c.repo && c.pr) pr = await lookAtPr(c.repo, c.pr);
  let contains: boolean | null = null;
  if (c.kind === 'deployed') {
    const commit = c.commit ?? (pr && 'mergeCommit' in pr ? pr.mergeCommit : null);
    if (commit) contains = await serverContains(commit);
  }
  const v = evaluate(c, { pr, contains, serverHead: await serverHead() }, now - t.armedAt);
  looks.set(a.id, { nextAt: now + nextCheckDelay(now - t.armedAt), lastSeen: v.text });
  if (v.verdict === 'waiting') return;
  // Met, or can no longer be (closed unmerged): run once with what was
  // seen as the body, then turn off.
  log(`automation "${a.name}": ${v.text}`);
  await off();
  const run = await runAutomation(uid, a, 'condition', v.text);
  if (!run.ok) log(`automation "${a.name}" failed: ${run.error}`);
}

export function startAutomationScheduler(log: (msg: string) => void) {
  // Start counting from now: a minute that passed while the server was down is not caught up.
  fired.clear();
  // The watches' timer (every 15 s) looks at schedules and conditions too.
  onWatchTick(() => tick(log));
  // A watch's report reaching its session is a run as well.
  onWatchDelivered((uid, w) => {
    void edit(uid, (s) => {
      s.runs.push({ id: randomUUID(), automationId: '', name: `Watch: ${w.label}`, at: Date.now(), source: 'watch', ok: w.outcome?.kind === 'met', projectId: w.projectId, sessionId: w.sessionId, ...(w.outcome && w.outcome.kind !== 'met' ? { error: w.outcome.text } : {}) });
      s.runs = s.runs.slice(-MAX_RUNS);
    }).catch(() => {});
  });
}

// ---- routes ----

export function registerAutomationRoutes(app: FastifyInstance) {
  app.get('/api/automations', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const s = await read(uid);
    const now = new Date();
    const watches = (await watchesOf(uid)).map((w) => ({ id: w.id, sessionId: w.sessionId, projectId: w.projectId, label: w.label, then: w.then, createdAt: w.createdAt, deadline: w.deadline, lastSeen: w.lastSeen }));
    return { automations: s.automations.map((a) => view(a, now)), runs: s.runs.slice(-100).reverse(), watches };
  });

  // Stop a watch a session's agent set (the session goes on waiting for the user).
  app.delete<{ Params: { sessionId: string; id: string } }>('/api/watches/:sessionId/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const gone = await cancelWatches(uid, req.params.sessionId, { id: req.params.id });
    return { ok: gone.length > 0 };
  });

  app.post<{ Body: any }>('/api/automations', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const out = await edit(uid, async (s) => {
      if (s.automations.length >= MAX_AUTOMATIONS) return { error: `At most ${MAX_AUTOMATIONS} automations` };
      const a = cleanAutomation({ ...(req.body ?? {}) as object, id: undefined });
      if ('error' in a) return a;
      if (!await getProject(uid, a.action.projectId)) return { error: 'Project not found' };
      s.automations.push(a);
      return a;
    });
    if ('error' in out) return reply.code(400).send(out);
    return view(out, new Date());
  });

  app.put<{ Params: { id: string }; Body: any }>('/api/automations/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const out = await edit(uid, async (s) => {
      const i = s.automations.findIndex((a) => a.id === req.params.id);
      if (i < 0) return { error: 'not found', code: 404 };
      const a = cleanAutomation(req.body, s.automations[i]);
      if ('error' in a) return a;
      if (!await getProject(uid, a.action.projectId)) return { error: 'Project not found' };
      s.automations[i] = a;
      return a;
    });
    if ('error' in out) return reply.code((out as any).code ?? 400).send({ error: out.error });
    return view(out, new Date());
  });

  app.delete<{ Params: { id: string } }>('/api/automations/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    await edit(uid, (s) => { s.automations = s.automations.filter((a) => a.id !== req.params.id); });
    return { ok: true };
  });

  // A new secret URL for a webhook; the old one stops working.
  app.post<{ Params: { id: string } }>('/api/automations/:id/rotate-token', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const out = await edit(uid, (s) => {
      const a = s.automations.find((x) => x.id === req.params.id);
      if (!a || a.trigger.kind !== 'webhook') return null;
      a.trigger = { kind: 'webhook', token: newToken() };
      return a;
    });
    if (!out) return reply.code(404).send({ error: 'not found' });
    return view(out, new Date());
  });

  app.post<{ Params: { id: string } }>('/api/automations/:id/run', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const a = (await read(uid)).automations.find((x) => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    return runAutomation(uid, a, 'manual');
  });

  // The webhook itself: no login, the token in the URL is the secret. Any
  // body (JSON or text) goes into the prompt.
  app.post<{ Params: { token: string } }>('/hooks/:token', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return reply.code(404).send({ error: 'not found' });
    for (const uid of await listUserIds()) {
      const a = (await read(uid)).automations.find((x) => x.trigger.kind === 'webhook' && x.trigger.token === token);
      if (!a) continue;
      if (!a.enabled) return reply.code(409).send({ error: 'This automation is turned off' });
      const last = lastWebhook.get(a.id) ?? 0;
      if (Date.now() - last < WEBHOOK_MIN_GAP_MS) return reply.code(429).send({ error: 'Too soon after the last call' });
      lastWebhook.set(a.id, Date.now());
      const b = req.body;
      const body = b === undefined || b === null || b === '' ? null : typeof b === 'string' ? b : JSON.stringify(b, null, 2);
      const run = await runAutomation(uid, a, 'webhook', body);
      return reply.code(run.ok ? 200 : 500).send({ ok: run.ok, runId: run.id, sessionId: run.sessionId, ...(run.error ? { error: run.error } : {}) });
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
