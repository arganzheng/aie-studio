import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import mime from 'mime-types';
import { getProject } from './store.js';
import { getUserId } from './auth.js';
import type { FastifyRequest } from 'fastify';
import { attachmentsRoot, planAttachment } from './attachments.js';

// mime-types is a web-server table: `.ts` is an MPEG transport stream, `.rs`
// is an XML dialect, and most source extensions are simply unknown. Editor
// semantics win here so the viewer renders code as text and the browser
// never tries to play a TypeScript file.
const SOURCE_MIME: Record<string, string> = {
  ts: 'text/typescript', mts: 'text/typescript', cts: 'text/typescript', tsx: 'text/tsx',
  jsx: 'text/jsx', mjs: 'text/javascript', cjs: 'text/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust',
  java: 'text/x-java', kt: 'text/x-kotlin', kts: 'text/x-kotlin', swift: 'text/x-swift',
  c: 'text/x-c', h: 'text/x-c', cc: 'text/x-c++', cpp: 'text/x-c++', hh: 'text/x-c++', hpp: 'text/x-c++',
  cs: 'text/x-csharp', php: 'text/x-php', lua: 'text/x-lua', vim: 'text/x-vim',
  sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript', fish: 'text/x-shellscript',
  vue: 'text/x-vue', svelte: 'text/x-svelte',
  jsonc: 'application/json', json5: 'application/json',
  env: 'text/plain', lock: 'text/plain',
};
const TEXT_BASENAMES = new Set([
  'makefile', 'license', 'codeowners', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
]);

export function lookupMime(file: string): string {
  const base = path.basename(file).toLowerCase();
  if (TEXT_BASENAMES.has(base) || base.startsWith('dockerfile') || base.startsWith('.env')) {
    return 'text/plain';
  }
  const ext = path.extname(base).slice(1);
  if (ext && SOURCE_MIME[ext]) return SOURCE_MIME[ext];
  return mime.lookup(file) || 'application/octet-stream';
}

// Model: server.ListDir rule-217 — every relative path is pinned under the
// project root; `../` escapes are a 400, never a filesystem access.
export function resolveRel(root: string, rel: string): string {
  const abs = path.resolve(root, (rel || '').replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error('path escapes project root'), { code: 400 });
  }
  return abs;
}

async function resolveInProject(req: FastifyRequest, projectId: string, rel: string) {
  const uid = getUserId(req);
  if (!uid) throw Object.assign(new Error('unauthorized'), { code: 401 });
  const project = await getProject(uid, projectId);
  if (!project) throw Object.assign(new Error('project not found'), { code: 404 });
  const abs = resolveRel(project.path, rel);
  return { project, abs };
}

function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

// Model: server.MoveEntry rule-407 / rule-409 — the pure path half of a move
// (rename = move within the same parent). Existence checks happen in the
// route because they need the filesystem.
export function planMove(root: string, fromRel: string, toRel: string) {
  const fromAbs = resolveRel(root, fromRel);
  const toAbs = resolveRel(root, toRel);
  if (fromAbs === root) throw Object.assign(new Error('cannot move the project root'), { code: 400 });
  if (toAbs === root) throw Object.assign(new Error('destination cannot be the project root'), { code: 400 });
  if (toAbs === fromAbs) throw Object.assign(new Error('source and destination are the same'), { code: 400 });
  if (toAbs.startsWith(fromAbs + path.sep)) {
    throw Object.assign(new Error('cannot move a directory into itself'), { code: 400 });
  }
  return { fromAbs, toAbs, fromRel: toRelPosix(root, fromAbs), toRel: toRelPosix(root, toAbs) };
}

// Model: server.MakeDir rule-414 — pure path half; existence checks in the route.
export function planMkdir(root: string, rel: string) {
  const abs = resolveRel(root, rel);
  if (abs === root) throw Object.assign(new Error('cannot create the project root'), { code: 400 });
  return { abs, rel: toRelPosix(root, abs) };
}

// Model: server.UploadFile rule-448 — pure path half: the destination is
// dir/name where dir is pinned under the root and name is a plain basename.
// Existence checks happen in the route because they need the filesystem.
export function planUpload(root: string, dirRel: string, name: string) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes(path.sep)) {
    throw Object.assign(new Error('invalid file name'), { code: 400 });
  }
  const dirAbs = resolveRel(root, dirRel);
  const abs = path.join(dirAbs, name);
  return { dirAbs, abs, rel: toRelPosix(root, abs) };
}

// Model: server.DeleteEntry rule-456 — pure path half; existence / emptiness
// checks happen in the route.
export function planDelete(root: string, rel: string) {
  const abs = resolveRel(root, rel);
  if (abs === root) throw Object.assign(new Error('cannot delete the project root'), { code: 400 });
  return { abs, rel: toRelPosix(root, abs) };
}

// Model: server.BrowseDirs — the ProjectManager's "Browse…" picker walks the
// server filesystem (the browser's native folder picker only sees the client
// machine). Pure path half: '' → home, leading ~ expands like addProject.
export function resolveBrowsePath(input: string | undefined, home = os.homedir()): string {
  const raw = (input ?? '').trim();
  if (!raw) return home;
  if (raw === '~' || raw.startsWith('~/')) return path.resolve(home, raw.slice(2));
  if (!path.isAbsolute(raw)) throw Object.assign(new Error('path must be absolute or start with ~'), { code: 400 });
  return path.resolve(raw);
}

// Model: server.BrowseMakeDir — pure path half of "+ New folder" in the
// server folder picker. Dot-names are refused: BrowseDirs hides them, so the
// new folder would vanish from the tree it was just created in.
export function planBrowseMkdir(input: string | undefined, home = os.homedir()): string {
  if (!(input ?? '').trim()) throw Object.assign(new Error('path required'), { code: 400 });
  const abs = resolveBrowsePath(input, home);
  const name = path.basename(abs);
  if (abs === path.dirname(abs)) throw Object.assign(new Error('cannot create the filesystem root'), { code: 400 });
  if (name.startsWith('.')) throw Object.assign(new Error('folder name cannot start with "."'), { code: 400 });
  return abs;
}

// rule-449 — one file per request, raw bytes, no multipart dependency.
export const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

// ReadFile refuses >20MB; the JSON envelope around a 20MB string needs a bit
// of headroom (escapes), and Fastify's default cap is only 1MB.
const WRITE_BODY_LIMIT = 24 * 1024 * 1024;

export function registerFsRoutes(app: FastifyInstance) {
  // rule-449 — hand the raw request stream to the upload route instead of
  // buffering it; Fastify's bodyLimit only applies to parsed bodies, so the
  // size cap is enforced in the route while streaming.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // Model: server.BrowseDirs — subdirectories only, dot-dirs hidden. Not
  // pinned to a project: any logged-in user can already add any path as a
  // project, so this exposes directory names and nothing more.
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse', async (req, reply) => {
    if (!getUserId(req)) return reply.code(401).send({ error: 'unauthorized' });
    let abs: string;
    try {
      abs = resolveBrowsePath(req.query.path);
    } catch (e: any) {
      return reply.code(e.code ?? 400).send({ error: e.message });
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (e: any) {
      const code = e.code === 'ENOENT' ? 404 : e.code === 'ENOTDIR' ? 400 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500;
      const msg = code === 404 ? 'directory not found' : code === 400 ? 'not a directory' : code === 403 ? 'permission denied' : e.message;
      return reply.code(code).send({ error: msg });
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      // Follow symlinks so linked folders are navigable; broken links drop out.
      if (!isDir && e.isSymbolicLink()) {
        isDir = await fs.stat(path.join(abs, e.name)).then((st) => st.isDirectory(), () => false);
      }
      if (isDir) dirs.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, home: os.homedir(), dirs };
  });

  // Model: server.BrowseMakeDir — one level only, like server.MakeDir, but
  // anywhere on the machine (same reach as adding any path as a project).
  app.post<{ Body: { path?: string } }>('/api/fs/browse/mkdir', async (req, reply) => {
    if (!getUserId(req)) return reply.code(401).send({ error: 'unauthorized' });
    let abs: string;
    try {
      abs = planBrowseMkdir(req.body?.path);
    } catch (e: any) {
      return reply.code(e.code ?? 400).send({ error: e.message });
    }
    const parentStat = await fs.stat(path.dirname(abs)).catch(() => null);
    if (!parentStat?.isDirectory()) return reply.code(400).send({ error: 'parent directory does not exist' });
    if (await fs.lstat(abs).catch(() => null)) return reply.code(409).send({ error: 'already exists' });
    try {
      await fs.mkdir(abs);
    } catch (e: any) {
      if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') return reply.code(403).send({ error: 'permission denied' });
      throw e;
    }
    return { path: abs };
  });

  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/list',
    async (req, reply) => {
      const projectId = req.query.project;
      if (!projectId) return reply.code(400).send({ error: 'project required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, req.query.path ?? ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) return reply.code(400).send({ error: 'not a directory' });
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        // rule-218: files carry their mime so the FileTree can offer
        // "Edit" for text files without a stat round-trip per row.
        .map((e) => ({
          name: e.name,
          path: path.join(req.query.path ?? '', e.name),
          isDir: e.isDirectory(),
          mime: e.isDirectory() ? undefined : lookupMime(e.name),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { path: req.query.path ?? '', items };
    },
  );

  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/file',
    async (req, reply) => {
      const projectId = req.query.project;
      const rel = req.query.path;
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (stat.size > 20 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (>20MB)' });
      }
      const type = lookupMime(abs);
      reply.header('Content-Type', type);
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(abs));
    },
  );

  // Raw file serving with the project + path encoded in the URL path itself,
  // not the query string. This is what lets HTML files load their relative
  // resources: opening /raw/<pid>/dir/page.html in a new window resolves a
  // `<link href="./style.css">` to /raw/<pid>/dir/style.css naturally — the
  // /api/fs/file?path=... shape can't do that because relative URL resolution
  // strips the query.
  app.get<{ Params: { projectId: string; '*': string } }>(
    '/raw/:projectId/*',
    async (req, reply) => {
      const projectId = req.params.projectId;
      const rel = req.params['*'] ?? '';
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (stat.size > 50 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (>50MB)' });
      }
      const type = lookupMime(abs);
      reply.header('Content-Type', type);
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(abs));
    },
  );

  // Model: server.MoveEntry (auc-126).
  app.post<{ Body: { project?: string; from?: string; to?: string } }>(
    '/api/fs/move',
    async (req, reply) => {
      const { project: projectId, from, to } = req.body ?? {};
      if (!projectId || !from || !to) {
        return reply.code(400).send({ error: 'project, from and to required' });
      }
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: ReturnType<typeof planMove>;
      try {
        plan = planMove(root, from, to);
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      // rule-408: source must exist, destination must not, and its parent
      // must be an existing directory. lstat so a dangling symlink at the
      // destination still counts as "exists".
      if (!(await fs.lstat(plan.fromAbs).catch(() => null))) {
        return reply.code(404).send({ error: 'source not found' });
      }
      const parentStat = await fs.stat(path.dirname(plan.toAbs)).catch(() => null);
      if (!parentStat?.isDirectory()) {
        return reply.code(400).send({ error: 'destination directory does not exist' });
      }
      if (await fs.lstat(plan.toAbs).catch(() => null)) {
        return reply.code(409).send({ error: 'destination already exists' });
      }
      await fs.rename(plan.fromAbs, plan.toAbs);
      return { from: plan.fromRel, to: plan.toRel };
    },
  );

  // Model: server.WriteFile (auc-128). Whole-file write-back for the editor
  // tab, with an optimistic-concurrency check on mtime.
  app.put<{ Body: { project?: string; path?: string; content?: string; baseMtimeMs?: number } }>(
    '/api/fs/file',
    { bodyLimit: WRITE_BODY_LIMIT },
    async (req, reply) => {
      const { project: projectId, path: rel, content, baseMtimeMs } = req.body ?? {};
      if (!projectId || !rel || typeof content !== 'string') {
        return reply.code(400).send({ error: 'project, path and content required' });
      }
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const before = await fs.stat(abs).catch(() => null);
      if (!before) return reply.code(404).send({ error: 'file not found' });
      if (!before.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (typeof baseMtimeMs === 'number' && before.mtimeMs !== baseMtimeMs) {
        return reply.code(409).send({ error: 'file changed on disk', mtimeMs: before.mtimeMs });
      }
      await fs.writeFile(abs, content, 'utf8');
      const after = await fs.stat(abs);
      return { path: rel, size: after.size, mtimeMs: after.mtimeMs };
    },
  );

  // Model: server.UploadFile (auc-133). Raw-bytes body; one file per request.
  // With attach=1 the file is a session attachment (server.SessionAttachments):
  // it goes outside the project and the reply names it by absolute path.
  app.post<{ Querystring: { project?: string; dir?: string; name?: string; overwrite?: string; attach?: string } }>(
    '/api/fs/upload',
    async (req, reply) => {
      const { project: projectId, dir, name, overwrite } = req.query;
      const attach = req.query.attach === '1';
      if (!projectId || typeof name !== 'string') {
        return reply.code(400).send({ error: 'project and name required' });
      }
      // rule-449: refuse up front when the client already tells us it is too big.
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
        return reply.code(413).send({ error: `file exceeds ${UPLOAD_MAX_BYTES} bytes` });
      }
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: { dirAbs: string; abs: string; rel: string };
      try {
        if (attach) {
          const a = planAttachment(attachmentsRoot(), getUserId(req) ?? '', name);
          await fs.mkdir(a.dirAbs, { recursive: true });
          plan = { ...a, rel: a.abs };
        } else {
          plan = planUpload(root, dir ?? '', name);
        }
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      // rule-448: the directory must already exist.
      const dirStat = await fs.stat(plan.dirAbs).catch(() => null);
      if (!dirStat?.isDirectory()) {
        return reply.code(400).send({ error: 'directory does not exist' });
      }
      // rule-450: never silently clobber; lstat so a dangling symlink counts.
      const existing = await fs.lstat(plan.abs).catch(() => null);
      if (existing) {
        if (overwrite !== '1') return reply.code(409).send({ error: 'already exists' });
        if (existing.isDirectory()) return reply.code(400).send({ error: 'destination is a directory' });
      }
      // rule-451: stream to a sibling temp file, rename on success.
      const tmp = path.join(plan.dirAbs, `.${name}.upload-${randomBytes(6).toString('hex')}`);
      let received = 0;
      const capped = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (received > UPLOAD_MAX_BYTES) {
            cb(Object.assign(new Error(`file exceeds ${UPLOAD_MAX_BYTES} bytes`), { code: 413 }));
            return;
          }
          cb(null, chunk);
        },
      });
      try {
        // Body is the raw stream (see the octet-stream parser above). A client
        // that sends no body / another content type gets a 400, not a crash.
        const body = req.body as NodeJS.ReadableStream | undefined;
        if (!body || typeof (body as any).pipe !== 'function') {
          return reply.code(400).send({ error: 'raw file body required (Content-Type: application/octet-stream)' });
        }
        await pipeline(body, capped, createWriteStream(tmp, { flags: 'wx' }));
        await fs.rename(tmp, plan.abs);
      } catch (e: any) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        if (attach) await fs.rm(plan.dirAbs, { recursive: true, force: true }).catch(() => {});
        return reply.code(e.code === 413 ? 413 : 500).send({ error: e.message ?? 'upload failed' });
      }
      // rule-452
      const after = await fs.stat(plan.abs);
      return { path: plan.rel, size: after.size, mtimeMs: after.mtimeMs };
    },
  );

  // Model: server.DeleteEntry (auc-134). Files and symlinks unlink; a
  // directory only goes if it is empty — recursive delete is deliberately
  // not offered (rule-457).
  app.delete<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/entry',
    async (req, reply) => {
      const { project: projectId, path: rel } = req.query;
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: ReturnType<typeof planDelete>;
      try {
        plan = planDelete(root, rel);
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const st = await fs.lstat(plan.abs).catch(() => null);
      if (!st) return reply.code(404).send({ error: 'not found' });
      try {
        if (st.isDirectory()) await fs.rmdir(plan.abs);
        else await fs.unlink(plan.abs);
      } catch (e: any) {
        if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST') {
          return reply.code(409).send({ error: 'directory not empty' });
        }
        return reply.code(500).send({ error: e?.message ?? 'delete failed' });
      }
      return { path: plan.rel };
    },
  );

  // Model: server.MakeDir (auc-127).
  app.post<{ Body: { project?: string; path?: string } }>(
    '/api/fs/mkdir',
    async (req, reply) => {
      const { project: projectId, path: rel } = req.body ?? {};
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: ReturnType<typeof planMkdir>;
      try {
        plan = planMkdir(root, rel);
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      // rule-415: one level only — the parent must already be a directory.
      const parentStat = await fs.stat(path.dirname(plan.abs)).catch(() => null);
      if (!parentStat?.isDirectory()) {
        return reply.code(400).send({ error: 'parent directory does not exist' });
      }
      if (await fs.lstat(plan.abs).catch(() => null)) {
        return reply.code(409).send({ error: 'already exists' });
      }
      await fs.mkdir(plan.abs);
      return { path: plan.rel };
    },
  );

  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/stat',
    async (req, reply) => {
      const projectId = req.query.project;
      const rel = req.query.path;
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      const type = stat.isDirectory() ? 'dir' : lookupMime(abs);
      return { path: rel, size: stat.size, isDir: stat.isDirectory(), mime: type, mtimeMs: stat.mtimeMs };
    },
  );
}
