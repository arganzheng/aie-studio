import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getUserId } from './auth.js';
import { cronMatches, describeCron, nextRun, parseCron } from './cron.js';
import { getAutomationsRaw, getProject, listUserIds, putAutomationsRaw } from './store.js';
import { sendToSession, startDetachedSession } from './sdk-session.js';

// Model: Automation — "when <trigger>, do <action>", run by the server on
// its own. Triggers: a schedule (cron, server local time) or a webhook (a
// secret URL anything can POST to). Actions: open a new Claude session in a
// project with a prompt (optionally in its own worktree), or send the prompt
// to an existing session. Every run is recorded with the session it started
// or wrote to; "Run now" runs one by hand. A run is an ordinary session: it
// shows in the Sessions list and alerts (push included) when it ends.
//
// The prompt may contain {{body}} (the webhook's request body) and {{date}}
// (the run's local date and time). A webhook body with no {{body}} in the
// prompt is added after it.

export type Trigger = { kind: 'schedule'; cron: string } | { kind: 'webhook'; token: string };
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
export type RunSource = 'schedule' | 'webhook' | 'manual';
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
  } else return { error: 'Pick a trigger: a schedule or a webhook' };
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
export function renderPrompt(prompt: string, o: { body?: string | null; now: Date }): string {
  const date = o.now.toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  const body = (o.body ?? '').slice(0, MAX_BODY);
  let out = prompt.replace(/\{\{\s*date\s*\}\}/g, date);
  if (/\{\{\s*body\s*\}\}/.test(out)) out = out.replace(/\{\{\s*body\s*\}\}/g, body);
  else if (body.trim()) out = `${out}\n\n---\nWebhook payload:\n\`\`\`\n${body}\n\`\`\``;
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
    const text = renderPrompt(a.prompt, { body, now: new Date() });
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
  if (a.trigger.kind === 'schedule') {
    schedule = describeCron(a.trigger.cron);
    try { next = a.enabled ? nextRun(parseCron(a.trigger.cron), now)?.getTime() ?? null : null; } catch {}
  }
  return { ...a, schedule, nextRunAt: next };
}

// ---- the scheduler: every 20 s, each enabled schedule due this minute ----

const fired = new Map<string, string>(); // automation id → the minute it last fired
export function minuteKey(d: Date): string { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`; }

async function tick(log: (msg: string) => void) {
  const now = new Date();
  const key = minuteKey(now);
  for (const uid of await listUserIds()) {
    let s: Stored;
    try { s = await read(uid); } catch { continue; }
    for (const a of s.automations) {
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

export function startAutomationScheduler(log: (msg: string) => void) {
  // Start counting from now: a minute that passed while the server was down is not caught up.
  fired.clear();
  const t = setInterval(() => { void tick(log).catch(() => {}); }, 20_000);
  t.unref?.();
  setTimeout(() => void tick(log).catch(() => {}), 2000).unref?.();
}

// ---- routes ----

export function registerAutomationRoutes(app: FastifyInstance) {
  app.get('/api/automations', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const s = await read(uid);
    const now = new Date();
    return { automations: s.automations.map((a) => view(a, now)), runs: s.runs.slice(-100).reverse() };
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
