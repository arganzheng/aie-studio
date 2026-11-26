import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import { git, isGitDir, resolveDir } from './changes.js';

// Model: server.ListProjectFiles — every file of a checkout, as paths
// relative to it, for the prompt box's "@" file picker (web.FileMentions).
// In a git checkout: what git tracks plus what is new and not ignored, so
// node_modules, build output and the like stay out. Elsewhere: a walk that
// skips dot directories and node_modules.

// More than a picker can usefully offer; a checkout larger than this is cut
// here and says so.
export const MAX_FILES = 20_000;
const SKIP_DIRS = new Set(['node_modules']);

// Pure: `git ls-files -z` output (NUL-separated) to paths, without those in
// `deleted` (tracked, but gone from the working tree).
export function parseFileList(out: string, deleted = '', max = MAX_FILES): { files: string[]; truncated: boolean } {
  const gone = new Set(deleted.split('\0').filter(Boolean));
  const seen = new Set<string>();
  for (const f of out.split('\0')) if (f && !gone.has(f)) seen.add(f);
  const all = [...seen];
  return { files: all.slice(0, max), truncated: all.length > max };
}

async function walk(root: string, max = MAX_FILES): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const todo = [''];
  while (todo.length) {
    const rel = todo.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) todo.push(p); continue; }
      if (!e.isFile()) continue;
      if (files.length >= max) return { files, truncated: true };
      files.push(p);
    }
  }
  return { files, truncated: false };
}

export async function listProjectFiles(dir: string): Promise<{ files: string[]; truncated: boolean }> {
  if (!await isGitDir(dir)) return walk(dir);
  const [listed, deleted] = await Promise.all([
    git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(dir, ['ls-files', '-z', '--deleted']).catch(() => ''),
  ]);
  return parseFileList(listed, deleted);
}

export function registerProjectFilesRoutes(app: FastifyInstance) {
  // Which checkout: a worktree by name, else the one a session runs in, else
  // the project (as for /changes).
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; session?: string } }>(
    '/api/projects/:id/files',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { dir } = await resolveDir(project.path, req.query);
      try { return await listProjectFiles(dir); }
      catch (e) { return reply.code(500).send({ error: String((e as Error).message) }); }
    },
  );
}
