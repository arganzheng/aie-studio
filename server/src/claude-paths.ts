import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Where Claude Code keeps a session's transcript:
//   ~/.claude/projects/<dir name>/<session id>.jsonl
// The dir name is the session's working directory, resolved through
// symlinks (/tmp → /private/tmp on macOS), with every character that is not
// a letter or a digit replaced by '-':
//   /Users/me/Code/me.github.com        → -Users-me-Code-me-github-com
//   <project>/.claude/worktrees/x       → …--claude-worktrees-x
// Replacing only '/' (as this code base used to) misses any path with a dot,
// underscore, space or symlink, and a chat tab then reloads empty.

export function claudeDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function realPathSync(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function claudeProjectsRoot(home = os.homedir()): string {
  return path.join(home, '.claude', 'projects');
}

// The directory Claude Code writes `cwd`'s sessions to.
export function claudeProjectDir(cwd: string, home = os.homedir()): string {
  return path.join(claudeProjectsRoot(home), claudeDirName(realPathSync(cwd)));
}

// Where a session's transcript is (or will be) written.
export function transcriptFile(cwd: string, sessionId: string, home = os.homedir()): string {
  return path.join(claudeProjectDir(cwd, home), `${sessionId}.jsonl`);
}

const SESSION_ID = /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/;
const found = new Map<string, string>();

async function isFile(p: string): Promise<boolean> {
  return fsp.stat(p).then((s) => s.isFile(), () => false);
}

// An existing transcript of `sessionId`: where Claude Code writes it for
// `cwd`, else under the old '/'-only name, else in whichever project
// directory has it (a very long path gets a hashed name; a session may have
// run in a worktree). null when there is none.
export async function findTranscript(cwd: string, sessionId: string, home = os.homedir()): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const key = `${home}\0${cwd}\0${sessionId}`;
  const cached = found.get(key);
  if (cached && await isFile(cached)) return cached;
  const root = claudeProjectsRoot(home);
  const candidates = [
    transcriptFile(cwd, sessionId, home),
    path.join(root, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`),
  ];
  for (const c of candidates) {
    if (await isFile(c)) { found.set(key, c); return c; }
  }
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    const c = path.join(root, d, `${sessionId}.jsonl`);
    if (await isFile(c)) { found.set(key, c); return c; }
  }
  return null;
}
