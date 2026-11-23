import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getUserId } from './auth.js';
import { getProject } from './store.js';
import { WORKTREES_DIR, isWorktreeName, realPath, sessionCwd, worktreePath } from './worktrees.js';
import { readPrStatus } from './changes-pr.js';

// Model: web.SidePanel / web.ChangesView — what a session changed, as the
// side panel's Changes tab shows it. A checkout (the project itself, or a
// child session's worktree under .claude/worktrees) is compared with the
// point where its branch left the main branch, so commits the agent already
// made show up next to what is still uncommitted; scope 'uncommitted' shows
// only the latter (against HEAD). Untracked files count as added.

export type DiffLine = {
  // '+' added, '-' removed, ' ' context, '\\' "No newline at end of file".
  t: '+' | '-' | ' ' | '\\';
  text: string;
  oldNo?: number;
  newNo?: number;
};
export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = {
  path: string;
  // The path before a rename.
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  // Lines were cut to keep the response small (FILE_LINE_CAP / TOTAL_LINE_CAP).
  truncated?: boolean;
  // Line count of the new version on disk (modified / renamed files), so the
  // unchanged stretch after the last hunk can say how long it is.
  newLines?: number;
};

export const FILE_LINE_CAP = 3000;
export const TOTAL_LINE_CAP = 20000;
// Untracked files: read at most this many, each up to this size.
export const UNTRACKED_FILE_CAP = 200;
export const UNTRACKED_BYTES_CAP = 256 * 1024;
// git's id for the empty tree: the base of a repository with no commit yet.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function unquote(p: string): string {
  // git quotes paths with unusual characters: "a\tb" → a<TAB>b.
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  try { return JSON.parse(p) as string; } catch { return p.slice(1, -1); }
}
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

// Pure: `git diff` (no colour, -M) → files with numbered lines. Lines past
// the caps are dropped and the file is marked truncated; its +/- counts still
// cover everything.
export function parseUnifiedDiff(text: string, caps = { file: FILE_LINE_CAP, total: TOTAL_LINE_CAP }): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let kept = 0;
  let fileKept = 0;
  const keep = (line: DiffLine) => {
    if (!f || !hunk) return;
    if (fileKept >= caps.file || kept >= caps.total) { f.truncated = true; return; }
    hunk.lines.push(line);
    fileKept++;
    kept++;
  };
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // Paths come from the ---/+++ or rename lines; this is the fallback.
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
      f = { path: m ? m[2] : raw.slice(11), status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(f);
      hunk = null;
      fileKept = 0;
      continue;
    }
    if (!f) continue;
    if (!hunk) {
      if (raw.startsWith('new file mode')) f.status = 'added';
      else if (raw.startsWith('deleted file mode')) f.status = 'deleted';
      else if (raw.startsWith('rename from ')) { f.oldPath = unquote(raw.slice(12)); f.status = 'renamed'; }
      else if (raw.startsWith('rename to ')) f.path = unquote(raw.slice(10));
      else if (raw.startsWith('Binary files ')) f.binary = true;
      else if (raw.startsWith('+++ ')) {
        const p = unquote(raw.slice(4));
        if (p !== '/dev/null') f.path = stripPrefix(p);
      }
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      hunk = { header: raw, lines: [] };
      if (fileKept < caps.file && kept < caps.total) f.hunks.push(hunk);
      else f.truncated = true;
      continue;
    }
    if (!hunk) continue;
    const c = raw[0];
    if (c === '+') { f.additions++; keep({ t: '+', text: raw.slice(1), newNo: newNo++ }); }
    else if (c === '-') { f.deletions++; keep({ t: '-', text: raw.slice(1), oldNo: oldNo++ }); }
    else if (c === ' ') keep({ t: ' ', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (c === '\\') keep({ t: '\\', text: raw.slice(2) });
  }
  return files;
}

// Pure: an untracked file as a diff that adds every line. `content` null =
// binary (or unreadable); `cut` = only the first part was read.
export function untrackedFile(relPath: string, content: string | null, cut = false, cap = FILE_LINE_CAP): DiffFile {
  if (content === null) return { path: relPath, status: 'untracked', binary: true, additions: 0, deletions: 0, hunks: [] };
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, cap);
  return {
    path: relPath,
    status: 'untracked',
    binary: false,
    additions: lines.length,
    deletions: 0,
    hunks: lines.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: shown.map((text, i) => ({ t: '+' as const, text, newNo: i + 1 })) }] : [],
    ...(cut || shown.length < lines.length ? { truncated: true } : {}),
  };
}

// Pure: the branch to compare with — the remote's default if it has one,
// else a local main / master. `branches`: local branch names and
// remote-tracking ones ("origin/main").
export function pickBaseBranch(branches: readonly string[], remoteHead: string | null): string | null {
  if (remoteHead) {
    const local = remoteHead.replace(/^[^/]+\//, '');
    if (branches.includes(local)) return local;
    if (branches.includes(remoteHead)) return remoteHead;
  }
  for (const b of ['main', 'master', 'origin/main', 'origin/master']) if (branches.includes(b)) return b;
  return null;
}

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: 30_000, maxBuffer }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout);
    });
  });
}

export type CheckoutSummary = {
  // null = the project directory itself.
  worktree: string | null;
  branch: string;
  // The branch compared with and the commit where this one left it; null
  // when there is none (no main branch, or no commit yet).
  base: string | null;
  mergeBase: string | null;
  // Commits since mergeBase, and files with uncommitted changes.
  ahead: number;
  dirty: number;
};

async function summarize(dir: string, worktree: string | null): Promise<CheckoutSummary> {
  const hasHead = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  const branch = hasHead ? (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() : '(no commit yet)';
  const branches = (await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => '')).split('\n').filter(Boolean);
  const remoteHead = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim() || null;
  const base = hasHead ? pickBaseBranch(branches, remoteHead) : null;
  const mergeBase = base ? (await git(dir, ['merge-base', 'HEAD', base]).catch(() => '')).trim() || null : null;
  const ahead = mergeBase ? Number((await git(dir, ['rev-list', '--count', `${mergeBase}..HEAD`])).trim()) || 0 : 0;
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
  const dirty = status.split('\n').filter((l) => l && !l.slice(3).startsWith(WORKTREES_DIR.split(path.sep).join('/') + '/')).length;
  return { worktree, branch, base, mergeBase, ahead, dirty };
}

export type Changes = CheckoutSummary & {
  scope: 'base' | 'uncommitted';
  files: DiffFile[];
};

async function readUntracked(dir: string): Promise<DiffFile[]> {
  const wtPrefix = WORKTREES_DIR.split(path.sep).join('/') + '/';
  const names = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter((p) => p && !p.startsWith(wtPrefix));
  const out: DiffFile[] = [];
  for (const rel of names.slice(0, UNTRACKED_FILE_CAP)) {
    const abs = path.join(dir, rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      const fh = await fs.open(abs, 'r');
      try {
        const len = Math.min(st.size, UNTRACKED_BYTES_CAP);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        out.push(untrackedFile(rel, buf.includes(0) ? null : buf.toString('utf8'), st.size > len));
      } finally { await fh.close(); }
    } catch { out.push(untrackedFile(rel, null)); }
  }
  return out;
}

export async function readChanges(dir: string, worktree: string | null, scope: 'base' | 'uncommitted'): Promise<Changes> {
  const summary = await summarize(dir, worktree);
  const hasHead = summary.branch !== '(no commit yet)';
  const ref = !hasHead ? EMPTY_TREE : scope === 'base' && summary.mergeBase ? summary.mergeBase : 'HEAD';
  const text = await git(dir, ['diff', '--no-color', '--no-ext-diff', '-M', ref, '--']);
  const files = [...parseUnifiedDiff(text), ...await readUntracked(dir)];
  for (const f of files) {
    if (f.binary || f.truncated || (f.status !== 'modified' && f.status !== 'renamed')) continue;
    const t = await readNewVersion(dir, f.path).catch(() => null);
    if (t != null) f.newLines = countLines(t);
  }
  return { ...summary, scope, files };
}

// Bigger new versions are not read (their stretches can't be opened).
export const NEW_VERSION_BYTES_CAP = 4 * 1024 * 1024;

// Pure: lines in a text file ("a\nb\n" and "a\nb" are both 2).
export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

// Pure: a diff path inside the checkout, or null when it would leave it.
export function insideCheckout(dir: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const abs = path.resolve(dir, rel);
  return abs.startsWith(dir + path.sep) ? abs : null;
}

// The new version of a changed file: what is on disk in the checkout now.
export async function readNewVersion(dir: string, rel: string): Promise<string> {
  const abs = insideCheckout(dir, rel);
  if (!abs) throw new Error('bad path');
  const real = await realPath(abs);
  if (!real.startsWith(dir + path.sep)) throw new Error('bad path');
  const st = await fs.stat(real);
  if (!st.isFile() || st.size > NEW_VERSION_BYTES_CAP) throw new Error('not readable');
  return fs.readFile(real, 'utf8');
}

// Where the Changes tab looks: a named worktree, the directory a session
// runs in, else the project.
async function resolveDir(projectPath: string, q: { worktree?: string; session?: string }): Promise<{ dir: string; worktree: string | null }> {
  const project = await realPath(projectPath);
  if (isWorktreeName(q.worktree)) {
    const dir = worktreePath(project, q.worktree);
    if (await fs.stat(dir).then((s) => s.isDirectory(), () => false)) return { dir, worktree: q.worktree };
  }
  if (q.session && /^[0-9a-f-]{8,64}$/i.test(q.session)) {
    const cwd = await realPath(await sessionCwd(projectPath, q.session));
    if (cwd !== project) return { dir: cwd, worktree: path.basename(cwd) };
  }
  return { dir: project, worktree: null };
}

async function isGitDir(dir: string): Promise<boolean> {
  return git(dir, ['rev-parse', '--is-inside-work-tree']).then((s) => s.trim() === 'true', () => false);
}

export function registerChangesRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; session?: string; scope?: string } }>(
    '/api/projects/:id/changes',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { dir, worktree } = await resolveDir(project.path, req.query);
      if (!await isGitDir(dir)) return { git: false, worktree };
      const scope = req.query.scope === 'uncommitted' ? 'uncommitted' : 'base';
      try { return { git: true, ...await readChanges(dir, worktree, scope) }; }
      catch (e) { return reply.code(500).send({ error: String((e as Error).message) }); }
    },
  );

  // The new version of one changed file, for opening the unchanged
  // stretches between hunks (model: web.ChangesView "diff rendering").
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; session?: string; path?: string } }>(
    '/api/projects/:id/changes/file',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { dir } = await resolveDir(project.path, req.query);
      try {
        const text = await readNewVersion(dir, req.query.path ?? '');
        return reply.type('text/plain; charset=utf-8').send(text);
      } catch (e) { return reply.code(404).send({ error: String((e as Error).message) }); }
    },
  );

  // The pull request of the branch the checkout is on, with its CI checks
  // (model: web.ChangesView "pull request"). fresh=1 skips the 30 s cache.
  app.get<{ Params: { id: string }; Querystring: { worktree?: string; session?: string; fresh?: string } }>(
    '/api/projects/:id/changes/pr',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { dir } = await resolveDir(project.path, req.query);
      if (!await isGitDir(dir)) return { pr: null, unavailable: 'Not a git repository' };
      const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
      if (!branch || branch === 'HEAD') return { pr: null, branch: branch || null };
      return { branch, ...await readPrStatus(dir, branch, req.query.fresh === '1') };
    },
  );

  // Every checkout the Changes tab can show: the project, then each worktree.
  app.get<{ Params: { id: string } }>('/api/projects/:id/changes/targets', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const root = await realPath(project.path);
    if (!await isGitDir(root)) return { git: false, targets: [] };
    const targets: CheckoutSummary[] = [await summarize(root, null)];
    const names = await fs.readdir(path.join(root, WORKTREES_DIR)).catch(() => [] as string[]);
    for (const name of names.filter(isWorktreeName).sort()) {
      const dir = worktreePath(root, name);
      if (await isGitDir(dir)) targets.push(await summarize(dir, name).catch(() => ({ worktree: name, branch: '?', base: null, mergeBase: null, ahead: 0, dirty: 0 })));
    }
    return { git: true, targets };
  });
}
