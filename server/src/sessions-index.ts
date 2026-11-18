import type { FastifyInstance } from 'fastify';
import { deleteSession, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { listProjectSessions, removeWorktreeIfClean } from './worktrees.js';
import { getUserId } from './auth.js';
import { getProject, getSessionMeta, listProjects, putSessionMeta, type Project, type SessionMeta } from './store.js';
import { liveBridge, type LiveState } from './live-sessions.js';
import { cliLiveState, stopCliSession } from './session.js';
import { sdkLiveDetail, sdkLiveState, stopSdkSession, userRenamedSdkSession } from './sdk-session.js';
import { countSubagents } from './subagents.js';
import { devinLiveState, listDevinSessionsInDb, stopDevinSession } from './devin.js';

// Model: server.ListAllSessions — one list of every AI session, Claude and
// Devin, for one project or all of them (web.SessionList). The per-kind
// resume lists stay as they are; this adds what a manager needs: live state,
// archive, rename, stop, delete.

export type SessionKind = 'claude' | 'devin';

export type SessionRow = {
  kind: SessionKind;
  sessionId: string;
  projectId: string;
  title: string;
  // ms since epoch of the last activity.
  updatedAt: number;
  // Which bridge holds a process for it right now; null = not running.
  live: 'cli' | 'sdk' | 'devin' | null;
  state: LiveState | null;
  archived: boolean;
  // Claude: the subagents it has spawned (absent for Devin). `running` is
  // only known while the SDK bridge holds the session.
  subagents?: { total: number; running: number };
  // The session this one was opened under as a child, if any.
  parentId?: string;
  // The batch label its parent's agent gave it (children opened together).
  group?: string;
  // Claude: the git worktree it runs in (a name under .claude/worktrees),
  // absent when it runs in the project directory.
  worktree?: string;
  // Claude on the SDK bridge, while its process is up: the tool call a
  // running turn last made, what the session has cost, and its spending cap.
  activity?: string;
  costUsd?: number;
  budgetUsd?: number;
};

export const MAX_TITLE_LENGTH = 200;

export function sessionKey(kind: SessionKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

// Pure: lay the user's archive flags and title overrides over the raw rows,
// newest first.
export function applySessionMeta(rows: readonly Omit<SessionRow, 'archived' | 'parentId' | 'group'>[], meta: SessionMeta): SessionRow[] {
  const archived = new Set(meta.archived);
  return rows
    .map((r) => {
      const key = sessionKey(r.kind, r.sessionId);
      const parentId = meta.parents[key];
      const group = parentId ? meta.groups[key] : undefined;
      return { ...r, title: meta.titles[key] ?? r.title, archived: archived.has(key), ...(parentId ? { parentId } : {}), ...(group ? { group } : {}) };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Pure: the meta after archiving / unarchiving one session.
export function setArchived(meta: SessionMeta, key: string, archived: boolean): SessionMeta {
  const rest = meta.archived.filter((k) => k !== key);
  return { ...meta, archived: archived ? [...rest, key] : rest };
}

// Pure: the meta after forgetting a session altogether (it was deleted).
export function forgetSession(meta: SessionMeta, key: string): SessionMeta {
  const { [key]: _gone, ...titles } = meta.titles;
  // Its own link goes, and so do the links of its children: they stay, as
  // top-level sessions.
  const id = key.slice(key.indexOf(':') + 1);
  const parents = Object.fromEntries(Object.entries(meta.parents).filter(([k, v]) => k !== key && v !== id));
  return {
    archived: meta.archived.filter((k) => k !== key), titles, parents,
    agentSpawned: meta.agentSpawned.filter((k) => k in parents),
    groups: Object.fromEntries(Object.entries(meta.groups).filter(([k]) => k in parents)),
  };
}

export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return t || null;
}

async function claudeRows(project: Project): Promise<Omit<SessionRow, 'archived'>[]> {
  let list: Awaited<ReturnType<typeof listProjectSessions>> = [];
  try { list = await listProjectSessions(project.path); } catch {}
  return Promise.all(list.map(async (s) => {
    const live = liveBridge(s.sessionId);
    return {
      kind: 'claude' as const,
      sessionId: s.sessionId,
      projectId: project.id,
      title: s.summary?.trim() || s.sessionId.slice(0, 8),
      updatedAt: s.lastModified,
      live,
      state: live === 'sdk' ? sdkLiveState(s.sessionId) : live === 'cli' ? cliLiveState(s.sessionId) : null,
      subagents: await countSubagents(s.cwd || project.path, s.sessionId),
      ...(s.worktree ? { worktree: s.worktree } : {}),
      ...(live === 'sdk' ? sdkLiveDetail(s.sessionId) : {}),
    };
  }));
}

function devinRows(project: Project): Omit<SessionRow, 'archived'>[] {
  return listDevinSessionsInDb(project.path).map((s) => {
    const state = devinLiveState(s.sessionId);
    return {
      kind: 'devin' as const,
      sessionId: s.sessionId,
      projectId: project.id,
      title: s.title?.trim() || s.sessionId,
      updatedAt: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0,
      live: state ? ('devin' as const) : null,
      state,
    };
  });
}

async function rowsFor(project: Project): Promise<Omit<SessionRow, 'archived'>[]> {
  return [...(await claudeRows(project)), ...devinRows(project)];
}

function stopLive(kind: SessionKind, sessionId: string, uid: string, opts: { silent?: boolean } = {}): boolean {
  if (kind === 'devin') return stopDevinSession(sessionId, uid);
  // One of the two Claude bridges holds it, at most.
  return stopSdkSession(sessionId, uid, opts) || stopCliSession(sessionId, uid);
}

// Pure: every session under `sessionId` in the tree (children, their
// children, …), nearest first. A link cycle is walked once.
export function descendantIds(parents: Readonly<Record<string, string>>, kind: SessionKind, sessionId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([sessionId]);
  for (let layer = [sessionId]; layer.length > 0;) {
    const next: string[] = [];
    for (const [k, v] of Object.entries(parents)) {
      const id = k.slice(k.indexOf(':') + 1);
      if (!k.startsWith(`${kind}:`) || !layer.includes(v) || seen.has(id)) continue;
      seen.add(id);
      next.push(id);
    }
    out.push(...next);
    layer = next;
  }
  return out;
}

type Target = { projectId?: string; kind?: string; sessionId?: string; withChildren?: boolean };

export function registerSessionIndexRoutes(app: FastifyInstance) {
  // The session named by a mutating request, checked against the caller's own
  // project: nothing here acts on a session id taken on faith.
  async function resolveTarget(uid: string, body: Target | undefined) {
    const kind = body?.kind;
    const sessionId = body?.sessionId;
    if ((kind !== 'claude' && kind !== 'devin') || typeof sessionId !== 'string' || !sessionId) {
      throw Object.assign(new Error('kind and sessionId required'), { code: 400 });
    }
    const project = body?.projectId ? await getProject(uid, body.projectId) : null;
    if (!project) throw Object.assign(new Error('project not found'), { code: 404 });
    const rows = kind === 'claude' ? await claudeRows(project) : devinRows(project);
    const row = rows.find((r) => r.sessionId === sessionId);
    if (!row) throw Object.assign(new Error('session not found in this project'), { code: 404 });
    return { kind: kind as SessionKind, sessionId, project, row };
  }

  app.get<{ Querystring: { project?: string } }>('/api/sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    let projects: Project[];
    if (!req.query.project || req.query.project === 'all') {
      projects = (await listProjects(uid)).filter((p) => !p.archived);
    } else {
      const p = await getProject(uid, req.query.project);
      if (!p) return reply.code(404).send({ error: 'project not found' });
      projects = [p];
    }
    const rows = (await Promise.all(projects.map(rowsFor))).flat();
    return { sessions: applySessionMeta(rows, await getSessionMeta(uid)) };
  });

  // Model: server.ArchiveSession — hide from the list; nothing is deleted.
  app.post<{ Body: Target & { archived?: boolean } }>('/api/sessions/archive', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const t = await resolveTarget(uid, req.body);
      await putSessionMeta(uid, setArchived(await getSessionMeta(uid), sessionKey(t.kind, t.sessionId), req.body?.archived !== false));
      return { ok: true };
    } catch (e: any) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  });

  // Model: server.RenameSession. Claude: the session's own custom title (the
  // SDK writes it to the jsonl; open tabs pick it up). Devin: a display name
  // kept on our side — Devin's store is not ours to write.
  app.post<{ Body: Target & { title?: string } }>('/api/sessions/rename', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const title = cleanTitle(req.body?.title);
    if (!title) return reply.code(400).send({ error: 'title required' });
    try {
      const t = await resolveTarget(uid, req.body);
      if (t.kind === 'claude') {
        await renameSession(t.sessionId, title, { dir: t.project.path });
        userRenamedSdkSession(t.sessionId, title);
      } else {
        const meta = await getSessionMeta(uid);
        await putSessionMeta(uid, { ...meta, titles: { ...meta.titles, [sessionKey(t.kind, t.sessionId)]: title } });
      }
      return { ok: true, title };
    } catch (e: any) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  });

  // Model: server.StopSession — end the process a bridge holds for it.
  app.post<{ Body: Target }>('/api/sessions/stop', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const t = await resolveTarget(uid, req.body);
      // "Stop with child sessions": the children go first and quietly, so
      // none of them reports to a parent that is about to stop too.
      let children = 0;
      if (req.body?.withChildren === true) {
        const meta = await getSessionMeta(uid);
        for (const id of descendantIds(meta.parents, t.kind, t.sessionId)) if (stopLive(t.kind, id, uid, { silent: true })) children++;
      }
      return { ok: true, stopped: stopLive(t.kind, t.sessionId, uid), children };
    } catch (e: any) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  });

  // Model: server.DeleteSession — Claude only: stop it, then remove its
  // transcript for good. Devin sessions live in Devin's own database; they
  // can be archived here but not deleted.
  app.post<{ Body: Target }>('/api/sessions/delete', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const t = await resolveTarget(uid, req.body);
      if (t.kind !== 'claude') return reply.code(400).send({ error: 'Devin sessions cannot be deleted here — archive it instead' });
      if (t.row.live && !stopLive(t.kind, t.sessionId, uid)) {
        return reply.code(409).send({ error: 'session is running and could not be stopped' });
      }
      await deleteSession(t.sessionId, { dir: t.project.path });
      await putSessionMeta(uid, forgetSession(await getSessionMeta(uid), sessionKey(t.kind, t.sessionId)));
      // Its worktree goes with it when nothing would be lost (no uncommitted
      // files, branch merged) and no other session lives there.
      let worktree: { name: string; removed: boolean; reason?: string } | undefined;
      if (t.row.worktree) {
        const shared = (await listProjectSessions(t.project.path).catch(() => [])).some((s) => s.worktree === t.row.worktree);
        worktree = { name: t.row.worktree, ...(shared ? { removed: false, reason: 'another session uses it' } : await removeWorktreeIfClean(t.project.path, t.row.worktree)) };
      }
      return { ok: true, worktree };
    } catch (e: any) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  });
}
