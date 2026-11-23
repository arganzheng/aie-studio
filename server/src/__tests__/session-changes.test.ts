import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aie-sc-')));
process.env.REMOTE_IDE_CONFIG_DIR = path.join(tmp, 'cfg');
const { SessionChanges, readSessionChanges, markSeen, snapRef, checkoutOf } = await import('../session-changes.js');

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function repo(name: string) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.md'), 'one\ntwo\nthree\n');
  g(d, 'add', '-A');
  g(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return d;
}
const SID = '11111111-2222-3333-4444-555555555555';
const paths = (r: Awaited<ReturnType<typeof readSessionChanges>>) => r.repos.flatMap((x) => x.files.map((f) => `${x.name}:${f.status}:${f.path}${f.touched ? '*' : ''}`)).sort();

let main: string;
let other: string;
beforeAll(() => { main = repo('main'); other = repo('other'); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('session changes', () => {
  it('knows nothing before the first message', async () => {
    const r = await readSessionChanges(SID, 'all');
    expect(r.none).toBe(true);
  });

  it('follows commits, uncommitted edits, new files and a second checkout', async () => {
    const sc = new SessionChanges(main, null);
    // Something already uncommitted before the session: not the session's.
    fs.writeFileSync(path.join(main, 'before.txt'), 'old\n');
    await sc.onUserMessage();
    await sc.setSessionId(SID);
    // The session edits, commits (like the blog's push to master), adds a file.
    await sc.beforeEdit(path.join(main, 'a.md'));
    fs.writeFileSync(path.join(main, 'a.md'), 'one\nTWO\nthree\n');
    g(main, 'add', 'a.md');
    g(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'edit');
    fs.writeFileSync(path.join(main, 'new.md'), 'hello\n');
    // An edit in another checkout: snapshotted before it happens.
    await sc.beforeEdit(path.join(other, 'a.md'));
    fs.writeFileSync(path.join(other, 'a.md'), 'one\ntwo\nthree\nfour\n');
    // Worktrees of the project are never part of a snapshot.
    fs.mkdirSync(path.join(main, '.claude', 'worktrees', 'x'), { recursive: true });
    fs.writeFileSync(path.join(main, '.claude', 'worktrees', 'x', 'f'), 'x\n');

    const all = await readSessionChanges(SID, 'all');
    expect(all.none).toBe(false);
    expect(paths(all)).toEqual(['main:added:new.md', 'main:modified:a.md*', 'other:modified:a.md*']);
    const a = all.repos.find((x) => x.name === 'main')!.files.find((f) => f.path === 'a.md')!;
    expect(a.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => l.t + l.text)).toEqual(['-two', '+TWO']);
    expect(a.newLines).toBe(3);
    expect(all.points.start).not.toBeNull();
    // The real index and HEAD are untouched.
    expect(g(main, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual(['?? .claude/', '?? before.txt', '?? new.md']);
    expect(g(main, 'for-each-ref', '--format=%(refname)', 'refs/aie-session/').trim().split('\n')).toContain(snapRef(SID, main, 'start'));
  });

  it('"Last agent turn" counts from the latest message; "seen" from the mark', async () => {
    const sc = new SessionChanges(main, SID);
    await sc.onUserMessage();
    expect(paths(await readSessionChanges(SID, 'turn'))).toEqual([]);
    fs.writeFileSync(path.join(main, 'new.md'), 'hello\nagain\n');
    expect(paths(await readSessionChanges(SID, 'turn'))).toEqual(['main:modified:new.md']);
    // No mark yet: since the start.
    expect(paths(await readSessionChanges(SID, 'seen'))).toHaveLength(3);
    await markSeen(SID);
    expect(paths(await readSessionChanges(SID, 'seen'))).toEqual([]);
    fs.writeFileSync(path.join(other, 'b.md'), 'b\n');
    expect(paths(await readSessionChanges(SID, 'seen'))).toEqual(['other:added:b.md']);
    expect((await readSessionChanges(SID, 'seen')).points.seen).not.toBeNull();
  });

  it('finds the checkout of a file that does not exist yet', async () => {
    expect(await checkoutOf(path.join(other, 'deep', 'dir', 'x.md'))).toBe(other);
    expect(await checkoutOf(path.join(tmp, 'nowhere.md'))).toBeNull();
  });
});
