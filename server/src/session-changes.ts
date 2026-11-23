import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff, readNewVersion, countLines, type DiffFile } from './changes.js';
import { WORKTREES_DIR, realPath } from './worktrees.js';

// Model: web.ChangesView "session scopes" — what one session changed, like
// Devin's Changes: everything since the session began, since the user's last
// message, or since they last marked the changes seen. A snapshot is the
// content of a checkout at a moment — commits, uncommitted edits and new
// files alike — taken with a throwaway index (the real index and the working
// tree are not touched) and kept alive by a hidden ref
// refs/aie-session/<session>/<checkout>/<label>. Comparing two snapshots by
// content means commits, pushes, amends and rebases in between don't matter.
// Snapshots are taken when the user writes (label "turn", the first one also
// "start"), before the session first edits a file in another checkout, and
// when the user marks the changes seen ("seen").

export type SnapLabel = 'start' | 'turn' | 'seen';
export type SessionScope = 'all' | 'turn' | 'seen';
const LABEL_OF: Record<SessionScope, SnapLabel> = { all: 'start', turn: 'turn', seen: 'seen' };

// Checkouts with more untracked files than this are not snapshotted (an
// unignored build output would be copied into the object store).
export const UNTRACKED_SNAPSHOT_CAP = 3000;
// Files the session edited, remembered for the "edited here" mark.
export const TOUCHED_CAP = 2000;

const ID_RE = /^[0-9a-f-]{8,64}$/i;

function stateDir(): string {
  return path.join(process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide'), 'session-changes');
}

type State = { repos: string[]; touched: string[] };

async function readState(sid: string): Promise<State> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(stateDir(), `${sid}.json`), 'utf8'));
    return { repos: Array.isArray(j.repos) ? j.repos.filter((r: unknown) => typeof r === 'string') : [], touched: Array.isArray(j.touched) ? j.touched.filter((r: unknown) => typeof r === 'string') : [] };
  } catch { return { repos: [], touched: [] }; }
}

const chains = new Map<string, Promise<unknown>>();
function editState<T>(sid: string, edit: (s: State) => T): Promise<T> {
  const next = (chains.get(sid) ?? Promise.resolve()).then(async () => {
    const s = await readState(sid);
    const before = JSON.stringify(s);
    const out = edit(s);
    if (JSON.stringify(s) !== before) {
      await fs.mkdir(stateDir(), { recursive: true });
      const file = path.join(stateDir(), `${sid}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(s));
      await fs.rename(tmp, file);
    }
    return out;
  });
  chains.set(sid, next.catch(() => {}));
  return next;
}

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout);
    });
  });
}

// The checkout a path is in (its top directory), or null outside git.
export async function checkoutOf(p: string): Promise<string | null> {
  let dir = p;
  // A file that doesn't exist yet: start from the nearest directory that does.
  for (let i = 0; i < 64; i++) {
    const ok = await fs.stat(dir).then((s) => s.isDirectory(), () => false);
    if (ok) break;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    return top ? await realPath(top) : null;
  } catch { return null; }
}

// Pure: the ref holding a session's snapshot of a checkout.
export function snapRef(sid: string, root: string, label: SnapLabel): string {
  const h = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return `refs/aie-session/${sid}/${h}/${label}`;
}

// A commit (no parents) of the checkout's content now: tracked files as they
// are on disk, deletions, and untracked files that are not ignored.
export async function snapshot(root: string): Promise<string | null> {
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '')).split('\0').filter(Boolean).length;
  if (untracked > UNTRACKED_SNAPSHOT_CAP) return null;
  const indexRel = (await git(root, ['rev-parse', '--git-path', 'index'])).trim();
  const tmp = path.join(os.tmpdir(), `aie-snap-${randomUUID()}`);
  try {
    // Start from the real index so unchanged files are not hashed again.
    await fs.copyFile(path.resolve(root, indexRel), tmp).catch(() => {});
    const env = {
      GIT_INDEX_FILE: tmp,
      GIT_AUTHOR_NAME: 'aie-studio', GIT_AUTHOR_EMAIL: 'aie-studio@localhost',
      GIT_COMMITTER_NAME: 'aie-studio', GIT_COMMITTER_EMAIL: 'aie-studio@localhost',
    };
    const wt = WORKTREES_DIR.split(path.sep).join('/');
    await git(root, ['add', '-A', '--', '.', `:(exclude,top)${wt}`], env);
    const tree = (await git(root, ['write-tree'], env)).trim();
    return (await git(root, ['commit-tree', tree, '-m', 'aie-studio session snapshot'], env)).trim();
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function setRef(root: string, ref: string, sha: string) {
  await git(root, ['update-ref', ref, sha]);
}
async function readRef(root: string, ref: string): Promise<{ sha: string; at: number } | null> {
  try {
    const out = (await git(root, ['show', '-s', '--format=%H %ct', ref])).trim().split(' ');
    return out[0] ? { sha: out[0], at: Number(out[1]) * 1000 } : null;
  } catch { return null; }
}

// One live session's snapshots. Snapshots taken before the session has an id
// (its first message) are kept here and written once it has one.
export class SessionChanges {
  private sid: string | null;
  private readonly cwd: string;
  private pending: Array<{ root: string; label: SnapLabel; sha: string }> = [];
  private known = new Set<string>();
  private loaded: Promise<void> = Promise.resolve();
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(cwd: string, sid: string | null) {
    this.cwd = cwd;
    this.sid = sid && ID_RE.test(sid) ? sid : null;
    if (this.sid) this.loaded = this.load(this.sid);
  }

  private async load(sid: string) {
    for (const r of (await readState(sid)).repos) this.known.add(r);
  }

  // Whatever snapshot is being taken has been taken (a tool call waits for
  // it, so the "before" really is before).
  idle(): Promise<void> { return this.inflight.then(() => {}, () => {}); }

  private run(job: () => Promise<void>): Promise<void> {
    const next = this.inflight.then(job, job).catch(() => {});
    this.inflight = next;
    return next;
  }

  async setSessionId(sid: string): Promise<void> {
    if (!ID_RE.test(sid) || sid === this.sid) return;
    this.sid = sid;
    await this.run(async () => {
      await this.load(sid);
      const pend = this.pending;
      this.pending = [];
      for (const p of pend) await this.record(p.root, p.label, p.sha);
    });
  }

  private async record(root: string, label: SnapLabel, sha: string) {
    if (!this.sid) { this.pending.push({ root, label, sha }); return; }
    const sid = this.sid;
    await setRef(root, snapRef(sid, root, label), sha);
    if (!this.known.has(root)) {
      this.known.add(root);
    }
    await editState(sid, (s) => { if (!s.repos.includes(root)) s.repos.push(root); });
  }

  private async hasStart(root: string): Promise<boolean> {
    if (!this.sid) return this.pending.some((p) => p.root === root && p.label === 'start');
    return (await readRef(root, snapRef(this.sid, root, 'start'))) !== null;
  }

  private async take(root: string, labels: SnapLabel[], onlyStartIfNew = false) {
    const fresh = !(await this.hasStart(root));
    if (onlyStartIfNew && !fresh) return;
    const sha = await snapshot(root).catch(() => null);
    if (!sha) return;
    const all = new Set<SnapLabel>(labels);
    if (fresh) { all.add('start'); all.add('turn'); }
    for (const l of all) await this.record(root, l, sha);
  }

  // The user wrote: a new "last turn" point in every checkout of the session.
  onUserMessage(): Promise<void> {
    return this.run(async () => {
      await this.loaded;
      const roots = new Set(this.known);
      const own = await checkoutOf(this.cwd);
      if (own) roots.add(own);
      for (const r of roots) await this.take(r, ['turn']);
    });
  }

  // About to edit `file`: the first edit in a checkout the session has not
  // been in yet snapshots it first. Remembers the file either way.
  beforeEdit(file: string): Promise<void> {
    return this.run(async () => {
      await this.loaded;
      const abs = path.resolve(this.cwd, file);
      const root = await checkoutOf(abs);
      if (root && !this.known.has(root) && !this.pending.some((p) => p.root === root)) await this.take(root, [], true);
      if (this.sid) {
        const sid = this.sid;
        await editState(sid, (s) => {
          if (!s.touched.includes(abs)) { s.touched.push(abs); if (s.touched.length > TOUCHED_CAP) s.touched.splice(0, s.touched.length - TOUCHED_CAP); }
        });
      }
    });
  }
}

export type SessionPoints = { start: number | null; turn: number | null; seen: number | null };
export type SessionRepoChanges = { root: string; name: string; files: DiffFile[]; error?: string };
export type SessionChangesResult = {
  // No snapshot yet (the session hasn't been written to since this feature).
  none: boolean;
  points: SessionPoints;
  repos: SessionRepoChanges[];
};

// The checkouts a session has snapshots of (only these may be read).
export async function sessionRepos(sid: string): Promise<string[]> {
  if (!ID_RE.test(sid)) return [];
  return (await readState(sid)).repos;
}

// What the session changed in each of its checkouts since the snapshot of
// `scope` ("seen" with none yet: since the start). Files the session edited
// carry touched: true.
export async function readSessionChanges(sid: string, scope: SessionScope): Promise<SessionChangesResult> {
  const st = ID_RE.test(sid) ? await readState(sid) : { repos: [], touched: [] };
  const touched = new Set(st.touched);
  const points: SessionPoints = { start: null, turn: null, seen: null };
  const repos: SessionRepoChanges[] = [];
  for (const root of st.repos) {
    const refs = {
      start: await readRef(root, snapRef(sid, root, 'start')),
      turn: await readRef(root, snapRef(sid, root, 'turn')),
      seen: await readRef(root, snapRef(sid, root, 'seen')),
    };
    if (refs.start) points.start = points.start == null ? refs.start.at : Math.min(points.start, refs.start.at);
    if (refs.turn) points.turn = Math.max(points.turn ?? 0, refs.turn.at);
    if (refs.seen) points.seen = Math.max(points.seen ?? 0, refs.seen.at);
    const base = refs[LABEL_OF[scope]] ?? refs.start;
    if (!base) continue;
    const name = path.basename(root);
    try {
      const now = await snapshot(root);
      if (!now) { repos.push({ root, name, files: [], error: `more than ${UNTRACKED_SNAPSHOT_CAP} untracked files` }); continue; }
      const text = await git(root, ['diff', '--no-color', '--no-ext-diff', '-M', base.sha, now, '--']);
      const files = parseUnifiedDiff(text);
      for (const f of files) {
        f.repo = root;
        if (touched.has(path.join(root, f.path))) f.touched = true;
        if (!f.binary && !f.truncated && (f.status === 'modified' || f.status === 'renamed')) {
          const t = await readNewVersion(root, f.path).catch(() => null);
          if (t != null) f.newLines = countLines(t);
        }
      }
      repos.push({ root, name, files });
    } catch (e) {
      repos.push({ root, name, files: [], error: String((e as Error).message ?? e) });
    }
  }
  return { none: st.repos.length === 0, points, repos };
}

// The user has seen everything up to now.
export async function markSeen(sid: string): Promise<void> {
  if (!ID_RE.test(sid)) return;
  for (const root of (await readState(sid)).repos) {
    const sha = await snapshot(root).catch(() => null);
    if (sha) await setRef(root, snapRef(sid, root, 'seen'), sha);
  }
}
