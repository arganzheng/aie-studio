import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { getUserId } from './auth.js';
import { getProject } from './store.js';

// Model: Session.worktree — a child session may work in its own git worktree
// so that sessions editing code at the same time don't write over each
// other. Worktrees live inside the project, where Claude Code keeps its own:
//   <project>/.claude/worktrees/<name>     on branch child/<name>
// A session there is still a session of the project: it is listed with it
// (and only worktrees under this directory are — a checkout the user keeps
// elsewhere is a project of its own).

export const WORKTREES_DIR = path.join('.claude', 'worktrees');
export const CHILD_BRANCH_PREFIX = 'child/';

export type WorktreeInfo = { name: string; path: string; branch: string };
export type WorktreeStatus = {
  name: string;
  branch: string;
  // Commits on the branch that the project's checked-out HEAD doesn't have.
  ahead: number;
  // Files with uncommitted changes in the worktree.
  dirty: number;
};

// Pure: "Draft Apple Pay tests" → "draft-apple-pay-tests-x7k2". `rand` makes
// it unique; git ref and path safe.
export function worktreeSlug(title: string, rand: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  const tail = rand.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'x';
  return `${base || 'child'}-${tail}`;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
export function isWorktreeName(s: unknown): s is string {
  return typeof s === 'string' && NAME_RE.test(s);
}

// Pure: the worktree `cwd` is (or is inside), as a name under the project's
// worktrees directory; null for the project itself or anywhere else. Both
// paths must already be resolved (realpath).
export function worktreeNameOf(projectPath: string, cwd: string): string | null {
  const root = path.join(projectPath, WORKTREES_DIR) + path.sep;
  if (!cwd.startsWith(root)) return null;
  const name = cwd.slice(root.length).split(path.sep)[0];
  return isWorktreeName(name) ? name : null;
}

export function worktreePath(projectPath: string, name: string): string {
  return path.join(projectPath, WORKTREES_DIR, name);
}

// Pure: the paragraph a child's report carries about its worktree.
export function worktreeNote(s: WorktreeStatus): string {
  const commits = s.ahead === 0 ? 'no new commits' : `${s.ahead} new commit${s.ahead === 1 ? '' : 's'}`;
  const dirty = s.dirty === 0 ? 'nothing uncommitted' : `${s.dirty} uncommitted file${s.dirty === 1 ? '' : 's'}`;
  const next = s.ahead === 0 && s.dirty === 0
    ? 'It changed nothing there.'
    : `To keep its work, merge or cherry-pick branch ${s.branch} into your branch${s.dirty > 0 ? ' (the uncommitted files are only in the worktree: have the child commit them first)' : ''}.`;
  return `Worktree: this child worked in ${path.join(WORKTREES_DIR, s.name)} on branch ${s.branch} — ${commits}, ${dirty}. ${next}`;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout);
    });
  });
}

export async function realPath(p: string): Promise<string> {
  return fs.realpath(p).catch(() => path.resolve(p));
}

// Keep the worktrees out of the project's `git status` without touching
// tracked files: a line in the repository's local exclude file.
async function excludeWorktreesDir(projectPath: string) {
  try {
    const common = (await git(projectPath, ['rev-parse', '--git-common-dir'])).trim();
    const file = path.resolve(projectPath, common, 'info', 'exclude');
    const line = `/${WORKTREES_DIR.split(path.sep).join('/')}/`;
    const cur = await fs.readFile(file, 'utf8').catch(() => '');
    if (cur.split('\n').some((l) => l.trim() === line)) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  } catch {}
}

// Model: server.CreateWorktree — a new worktree for a child session, branched
// from what `fromCwd` has checked out (the project, or the parent's own
// worktree). Uncommitted changes there are not carried over.
export async function createWorktree(projectPath: string, fromCwd: string, title: string): Promise<WorktreeInfo> {
  const project = await realPath(projectPath);
  try { await git(project, ['rev-parse', '--is-inside-work-tree']); }
  catch { throw new Error('this project is not a git repository, so a child session cannot be given its own worktree'); }
  let head: string;
  try { head = (await git(fromCwd, ['rev-parse', 'HEAD'])).trim(); }
  catch { throw new Error('the repository has no commit yet; commit something before opening a child session in a worktree'); }
  const name = worktreeSlug(title, Math.random().toString(36).slice(2, 6));
  const dir = worktreePath(project, name);
  const branch = `${CHILD_BRANCH_PREFIX}${name}`;
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await excludeWorktreesDir(project);
  await git(project, ['worktree', 'add', '-b', branch, dir, head]);
  return { name, path: dir, branch };
}

export async function worktreeStatus(projectPath: string, name: string): Promise<WorktreeStatus | null> {
  const project = await realPath(projectPath);
  const dir = worktreePath(project, name);
  try {
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const ahead = Number((await git(project, ['rev-list', '--count', `HEAD..${branch === 'HEAD' ? (await git(dir, ['rev-parse', 'HEAD'])).trim() : branch}`])).trim()) || 0;
    const dirty = (await git(dir, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
    return { name, branch, ahead, dirty };
  } catch { return null; }
}

// Model: server.RemoveWorktree — only when nothing would be lost: git itself
// refuses a worktree with uncommitted changes and a branch that isn't merged.
export async function removeWorktreeIfClean(projectPath: string, name: string): Promise<{ removed: boolean; reason?: string }> {
  if (!isWorktreeName(name)) return { removed: false, reason: 'not a worktree name' };
  const project = await realPath(projectPath);
  const dir = worktreePath(project, name);
  const status = await worktreeStatus(project, name);
  if (!status) return { removed: false, reason: 'worktree not found' };
  if (status.dirty > 0) return { removed: false, reason: `${status.dirty} uncommitted file${status.dirty === 1 ? '' : 's'}` };
  if (status.ahead > 0) return { removed: false, reason: `branch ${status.branch} has ${status.ahead} commit${status.ahead === 1 ? '' : 's'} that ${status.ahead === 1 ? "isn't" : "aren't"} merged` };
  try {
    await git(project, ['worktree', 'remove', dir]);
    if (status.branch.startsWith(CHILD_BRANCH_PREFIX)) await git(project, ['branch', '-d', status.branch]).catch(() => {});
    return { removed: true };
  } catch (e) { return { removed: false, reason: String((e as Error).message) }; }
}

// Where a session of the project runs: its worktree if it was started in one
// (and the worktree is still there), else the project directory.
export async function sessionCwd(projectPath: string, sessionId: string): Promise<string> {
  try {
    const info = await getSessionInfo(sessionId, { dir: projectPath });
    const cwd = info?.cwd ? await realPath(info.cwd) : null;
    if (cwd && worktreeNameOf(await realPath(projectPath), cwd) && await fs.stat(cwd).then((s) => s.isDirectory(), () => false)) return cwd;
  } catch {}
  return projectPath;
}

// Model: server.ListProjectSessions — the project's sessions plus those of
// the worktrees under it, each tagged with its worktree name.
export async function listProjectSessions(projectPath: string) {
  const project = await realPath(projectPath);
  const list = await listSessions({ dir: projectPath, includeWorktrees: true });
  const out: (typeof list[number] & { worktree: string | null })[] = [];
  const real = new Map<string, string>();
  for (const s of list) {
    if (s.cwd && !real.has(s.cwd)) real.set(s.cwd, await realPath(s.cwd));
    const cwd = s.cwd ? real.get(s.cwd)! : project;
    if (cwd === project) out.push({ ...s, worktree: null });
    else {
      const name = worktreeNameOf(project, cwd);
      if (name) out.push({ ...s, worktree: name });
    }
  }
  return out;
}

export function registerWorktreeRoutes(app: FastifyInstance) {
  // Model: server.CreateWorktree, for web.NewChildSession "in a worktree":
  // the tab then starts its session there (handshake worktree=<name>).
  app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/projects/:id/worktrees', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    try {
      const wt = await createWorktree(project.path, project.path, String(req.body?.title ?? '').trim() || 'child');
      return { name: wt.name, branch: wt.branch, path: path.relative(await realPath(project.path), wt.path) };
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });
}
