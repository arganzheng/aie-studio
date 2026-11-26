import type { FastifyInstance } from 'fastify';
import { liveBridge } from './live-sessions.js';
import { localCommandOutputs } from './local-command-output.js';
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  listProjects,
  addProject,
  deleteProject,
  updateProject,
  reorderProjects,
  getProject,
  getWorkspace,
  putWorkspace,
  putProjectWorkspace,
  getSettings,
  putSettings,
  type Workspace,
  type ProjectWorkspace,
  type Settings,
} from './store.js';
import { getUserId } from './auth.js';
import { countWireRecords, wireDir } from './observe/wire.js';
import { planToolCalls } from './plan-tools.js';
import { killTerminals, terminalAllowed } from './terminal.js';
import { sessionArtifacts, transcriptImage } from './artifacts.js';
import { claudeProjectDir, findTranscript } from './claude-paths.js';


export function registerProjectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return listProjects(uid);
  });

  app.post<{ Body: { path: string; name?: string } }>('/api/projects', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body?.path) return reply.code(400).send({ error: 'path required' });
    try {
      const p = await addProject(uid, req.body);
      return p;
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Model: server.ReorderProjects (web.ReorderProjects). Registered on a
  // literal path; PATCH/DELETE below use /:id, so no overlap.
  app.put<{ Body: { ids: string[] } }>('/api/projects/order', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return await reorderProjects(uid, req.body?.ids);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Model: server.UpdateProject — currently only `archived` (web.ArchiveProject).
  app.patch<{ Params: { id: string }; Body: { archived?: boolean } }>('/api/projects/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const body = req.body ?? {};
    const patch: { archived?: boolean } = {};
    if (typeof body.archived === 'boolean') patch.archived = body.archived;
    const p = await updateProject(uid, req.params.id, patch);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return p;
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    await deleteProject(uid, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const dir = claudeProjectDir(project.path);
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { sessions: [] };
    }
    // Model: server.ListSessions rule-403 — row title = SDK summary
    // (custom-title > ai-title > first prompt). One listSessions call, keyed
    // by sessionId; failures just leave titles empty.
    const titleById = new Map<string, string>();
    try {
      for (const s of await sdkListSessions({ dir: project.path, includeWorktrees: false })) {
        if (s.summary) titleById.set(s.sessionId, s.summary);
      }
    } catch {}
    const items = await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map(async (f) => {
          const full = path.join(dir, f);
          const st = await fs.stat(full);
          const uuid = f.replace(/\.jsonl$/, '');
          // Scan the head of the file for the first user text message (skipping
          // housekeeping records like permission-mode / file-history-snapshot).
          let preview = '';
          try {
            const fd = await fs.open(full, 'r');
            const buf = Buffer.alloc(Math.min(st.size, 65536));
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            await fd.close();
            const head = buf.toString('utf8', 0, bytesRead);
            for (const line of head.split('\n')) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type !== 'user') continue;
                const content = obj?.message?.content;
                if (typeof content === 'string') { preview = content; break; }
                if (Array.isArray(content)) {
                  const t = content.find((c: any) => c.type === 'text')?.text;
                  if (t) { preview = t; break; }
                }
              } catch {}
            }
          } catch {}
          // Model: server.ListSessions — ⚡ mark for the resume picker: how many
          // wire-proxy records this session has under <cwd>/.aie/observations/wire/.
          const wire = await countWireRecords(wireDir(project.path, uuid));
          return {
            uuid,
            mtime: st.mtimeMs,
            size: st.size,
            preview: preview.slice(0, 120),
            title: titleById.get(uuid) ?? null,
            wire,
            // Model: server.ListSessions — which bridge holds a process now.
            live: liveBridge(uuid),
          };
        }),
    );
    items.sort((a, b) => b.mtime - a.mtime);
    return { sessions: items };
  });

  app.get<{
    Params: { id: string; uuid: string };
    Querystring: { limit?: string; before?: string; plan?: string; artifacts?: string; image?: string };
  }>(
    '/api/projects/:id/sessions/:uuid/transcript',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      // Model: server.ReadTranscript — where claude wrote it (claude-paths.ts).
      const file = await findTranscript(project.path, req.params.uuid);
      if (!file) return reply.code(404).send({ error: 'transcript not found' });
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (e: any) {
        if (e.code === 'ENOENT') return reply.code(404).send({ error: 'transcript not found' });
        throw e;
      }
      const all: any[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' || obj.type === 'assistant') all.push(obj);
        } catch {}
      }
      // Model: web.ProgressView — plan=all: only the task list's tool calls,
      // from the whole transcript.
      if (req.query.plan === 'all') return { planTools: planToolCalls(all), total: all.length };
      // Model: web.ArtifactsView — files the session wrote or was handed.
      if (req.query.artifacts === '1') return { ...sessionArtifacts(all, project.path), total: all.length };
      // Model: web.ArtifactsView — one image the user pasted, by its ref.
      if (typeof req.query.image === 'string') {
        const img = transcriptImage(all, req.query.image);
        if (!img) return reply.code(404).send({ error: 'image not found' });
        reply.header('Content-Type', img.mediaType);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Cache-Control', 'private, max-age=3600');
        return reply.send(img.data);
      }
      const total = all.length;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 20));
      const endIdx =
        req.query.before !== undefined
          ? Math.max(0, Math.min(total, Number(req.query.before)))
          : total;
      const startIdx = Math.max(0, endIdx - limit);
      // localCommandOutput: what a slash command printed (local-command-output.ts).
      const cmdOut = localCommandOutputs(raw);
      return {
        events: all.slice(startIdx, endIdx).map((e) => (cmdOut.has(e.uuid) ? { ...e, localCommandOutput: cmdOut.get(e.uuid) } : e)),
        startIndex: startIdx,
        endIndex: endIdx,
        total,
        // Model: web.PlanStrip — plan tool calls from the part not sent.
        planTools: planToolCalls(all.slice(0, startIdx)),
      };
    },
  );

  app.get('/api/workspace', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return getWorkspace(uid);
  });

  app.put<{ Body: Workspace }>('/api/workspace', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body || typeof req.body !== 'object') {
      return reply.code(400).send({ error: 'invalid body' });
    }
    return putWorkspace(uid, req.body);
  });

  // Per-project workspace update — merges only this project's slot so a
  // client PUT for project X can't overwrite project Y's tab list. See the
  // corresponding client-side saveProjectTabs in App.tsx.
  app.put<{ Params: { pid: string }; Body: ProjectWorkspace }>(
    '/api/workspace/projects/:pid',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const body = req.body as any;
      if (!body || typeof body !== 'object' || !Array.isArray(body.tabs)) {
        return reply.code(400).send({ error: 'invalid body' });
      }
      return putProjectWorkspace(uid, req.params.pid, body);
    },
  );

  app.get('/api/settings', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return getSettings(uid);
  });

  app.put<{ Body: Settings }>('/api/settings', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body || typeof req.body !== 'object') {
      return reply.code(400).send({ error: 'invalid body' });
    }
    const saved = await putSettings(uid, req.body);
    // Model: server.TerminalBridge — turning the Terminal off ends its shells.
    if (!terminalAllowed(saved)) killTerminals(uid);
    return saved;
  });
}
