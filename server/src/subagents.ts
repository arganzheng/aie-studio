import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import { liveBridge } from './live-sessions.js';
import { sdkTasks, stopSdkTask, type SdkTask } from './sdk-session.js';
import { sessionCwd } from './worktrees.js';

// Model: Claude Session.subagents — the child agents a Claude session
// spawned through its Agent tool (web.SessionList tree, web.SubagentPanel).
// Claude keeps one transcript per child next to the session's own:
//   <config>/projects/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl
//   …/agent-<id>.meta.json   { agentType, description, toolUseId, finished, … }
// Children run inside the parent's process: they can be read and stopped
// here, not messaged (the SDK connection has no send-to-task request).

export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped';

export type SubagentInfo = {
  agentId: string;
  // The child that spawned this one; null = spawned by the session itself.
  parentAgentId: string | null;
  agentType: string;
  description: string;
  status: SubagentStatus;
  background: boolean;
  model: string | null;
  // ms since epoch.
  startedAt: number;
  updatedAt: number;
  // Live progress, only while the SDK bridge holds the session.
  totalTokens: number | null;
  toolUses: number | null;
  lastTool: string | null;
  // Stoppable right now (running under the SDK bridge).
  canStop: boolean;
  // The SDK task behind it while the bridge knows one.
  taskId: string | null;
  // The session's Agent tool call that spawned it (the chat anchor t:<id>).
  toolUseId: string | null;
};

export type SubagentMetaFile = {
  agentType?: unknown;
  description?: unknown;
  toolUseId?: unknown;
  parentAgentId?: unknown;
  requestShape?: unknown;
  pickedEffortModel?: unknown;
  model?: unknown;
  finished?: unknown;
};

// A child with no `finished` mark and no live task is still "running" for
// this long after its last transcript write (the CLI bridge reports no task
// events, so the file is all there is to go on).
export const QUIET_RUNNING_MS = 120_000;

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isAgentId(s: unknown): s is string {
  return typeof s === 'string' && AGENT_ID_RE.test(s);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// Pure: one child's row from its meta file, file times and (if any) the live
// task the SDK bridge tracks for it.
export function subagentInfo(opts: {
  agentId: string;
  meta: SubagentMetaFile;
  startedAt: number;
  updatedAt: number;
  task: SdkTask | null;
  sessionLive: boolean;
  now: number;
}): SubagentInfo {
  const { meta, task } = opts;
  let status: SubagentStatus;
  if (task?.status === 'running') status = 'running';
  else if (task?.status === 'failed') status = 'failed';
  else if (task?.status === 'stopped') status = 'stopped';
  else if (meta.finished === true || task?.status === 'completed') status = 'done';
  else if (opts.sessionLive && opts.now - opts.updatedAt < QUIET_RUNNING_MS) status = 'running';
  else status = 'stopped';
  return {
    agentId: opts.agentId,
    parentAgentId: str(meta.parentAgentId),
    agentType: str(meta.agentType) ?? 'agent',
    description: str(meta.description) ?? task?.description ?? opts.agentId,
    status,
    background: meta.requestShape === 'background' || task?.background === true,
    model: str(meta.model) ?? str(meta.pickedEffortModel),
    startedAt: opts.startedAt,
    updatedAt: opts.updatedAt,
    totalTokens: task?.totalTokens ?? null,
    toolUses: task?.toolUses ?? null,
    lastTool: task?.lastTool ?? null,
    canStop: task?.status === 'running',
    taskId: task?.taskId ?? null,
    toolUseId: str(meta.toolUseId) ?? task?.toolUseId ?? null,
  };
}

// Pure: parents before their children, siblings oldest first; a child whose
// parent is missing hangs off the session. `depth` 0 = spawned by the session.
export function orderSubagents<T extends { agentId: string; parentAgentId: string | null; startedAt: number }>(list: readonly T[]): (T & { depth: number })[] {
  const ids = new Set(list.map((s) => s.agentId));
  const kids = new Map<string | null, T[]>();
  for (const s of list) {
    const p = s.parentAgentId && ids.has(s.parentAgentId) && s.parentAgentId !== s.agentId ? s.parentAgentId : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  const out: (T & { depth: number })[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of [...(kids.get(parent) ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
      if (seen.has(s.agentId)) continue;
      seen.add(s.agentId);
      out.push({ ...s, depth });
      walk(s.agentId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
// Claude names a project's directory after its cwd with every
// non-alphanumeric character replaced by '-'.
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

// The session's subagents directory, or null when it has none. The cwd is
// tried as given and resolved (macOS: /tmp → /private/tmp).
async function findSubagentsDir(cwd: string, sessionId: string): Promise<string | null> {
  const real = await fs.realpath(cwd).catch(() => cwd);
  for (const c of new Set([real, cwd])) {
    const dir = path.join(configDir(), 'projects', encodeProjectDir(c), sessionId, 'subagents');
    if (await fs.stat(dir).then((s) => s.isDirectory(), () => false)) return dir;
  }
  return null;
}

// How many children a session has and how many are running — one readdir
// plus the bridge's task table, for the Sessions list. `running` is only
// known under the SDK bridge.
export async function countSubagents(cwd: string, sessionId: string): Promise<{ total: number; running: number }> {
  const dir = await findSubagentsDir(cwd, sessionId);
  if (!dir) return { total: 0, running: 0 };
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const ids = new Set(names.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).map((n) => n.slice('agent-'.length, -'.jsonl'.length)));
  const running = sdkTasks(sessionId).filter((t) => t.status === 'running' && ids.has(t.taskId)).length;
  return { total: ids.size, running };
}

export async function listSubagentInfo(cwd: string, sessionId: string): Promise<(SubagentInfo & { depth: number })[]> {
  const dir = await findSubagentsDir(cwd, sessionId);
  if (!dir) return [];
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const tasks = sdkTasks(sessionId);
  const sessionLive = liveBridge(sessionId) !== null;
  const now = Date.now();
  const list: SubagentInfo[] = [];
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
    const agentId = name.slice('agent-'.length, -'.jsonl'.length);
    if (!isAgentId(agentId)) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!st) continue;
    let meta: SubagentMetaFile = {};
    try { meta = JSON.parse(await fs.readFile(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')); } catch {}
    const toolUseId = str(meta.toolUseId);
    const task = tasks.find((t) => t.taskId === agentId || (toolUseId !== null && t.toolUseId === toolUseId)) ?? null;
    list.push(subagentInfo({
      agentId, meta, task, sessionLive, now,
      startedAt: st.birthtimeMs || st.mtimeMs,
      updatedAt: st.mtimeMs,
    }));
  }
  return orderSubagents(list);
}

export function registerSubagentRoutes(app: FastifyInstance) {
  type P = { id: string; sid: string; aid?: string };
  async function resolve(req: { params: P }, uid: string | null) {
    if (!uid) throw Object.assign(new Error('unauthorized'), { code: 401 });
    const project = await getProject(uid, req.params.id);
    if (!project) throw Object.assign(new Error('project not found'), { code: 404 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(req.params.sid)) throw Object.assign(new Error('bad session id'), { code: 400 });
    if (req.params.aid !== undefined && !isAgentId(req.params.aid)) throw Object.assign(new Error('bad agent id'), { code: 400 });
    return project;
  }
  const fail = (reply: any, e: any) => reply.code(typeof e?.code === 'number' ? e.code : 500).send({ error: String(e?.message ?? e) });

  // Model: server.ListSubagents.
  app.get<{ Params: P }>('/api/projects/:id/sdk-sessions/:sid/subagents', async (req, reply) => {
    try {
      const project = await resolve(req, getUserId(req));
      return { subagents: await listSubagentInfo(await sessionCwd(project.path, req.params.sid), req.params.sid) };
    } catch (e) { return fail(reply, e); }
  });

  // Model: server.ReadSubagentTranscript — the whole child conversation
  // (they are short next to a session's); `after` = events the caller already
  // has, so a poll of a running child only carries the new tail.
  app.get<{ Params: P; Querystring: { after?: string } }>('/api/projects/:id/sdk-sessions/:sid/subagents/:aid/transcript', async (req, reply) => {
    try {
      const project = await resolve(req, getUserId(req));
      let msgs;
      try { msgs = await getSubagentMessages(req.params.sid, req.params.aid!, { dir: project.path }); }
      catch { return reply.code(404).send({ error: 'subagent transcript not found' }); }
      const after = Math.max(0, Math.min(msgs.length, Number(req.query.after ?? 0) || 0));
      const info = (await listSubagentInfo(await sessionCwd(project.path, req.params.sid), req.params.sid)).find((s) => s.agentId === req.params.aid) ?? null;
      return {
        events: msgs.slice(after).map((m) => ({ type: m.type, uuid: m.uuid, message: m.message })),
        startIndex: after,
        total: msgs.length,
        info,
      };
    } catch (e) { return fail(reply, e); }
  });

  // Model: server.StopSubagent — ends one child; the session carries on and
  // is told the child was stopped.
  app.post<{ Params: P }>('/api/projects/:id/sdk-sessions/:sid/subagents/:aid/stop', async (req, reply) => {
    try {
      const uid = getUserId(req);
      const project = await resolve(req, uid);
      const info = (await listSubagentInfo(await sessionCwd(project.path, req.params.sid), req.params.sid)).find((s) => s.agentId === req.params.aid);
      if (!info) return reply.code(404).send({ error: 'subagent not found' });
      if (!info.canStop) return reply.code(409).send({ error: 'subagent is not running in a live Claude (SDK) session' });
      const ok = info.taskId !== null && await stopSdkTask(req.params.sid, uid!, info.taskId);
      if (!ok) return reply.code(409).send({ error: 'subagent is no longer running' });
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });
}
