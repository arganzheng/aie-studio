import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The service against a temp config dir and a fake `gh` whose answers come
// from a JSON file the test edits.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-watch-test-'));
const stateFile = path.join(dir, 'gh-state.json');
const ghBin = path.join(dir, 'gh');
fs.writeFileSync(ghBin, `#!/usr/bin/env node
const s = JSON.parse(require('fs').readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const a = process.argv.slice(2);
if (a.includes('--repo')) {
  const n = Number(a[2]);
  const pr = s.prs[n];
  if (!pr) { process.stderr.write('no pull requests found'); process.exit(1); }
  process.stdout.write(JSON.stringify({ number: n, title: 'PR ' + n, url: 'https://github.com/o/r/pull/' + n, isDraft: false, statusCheckRollup: [], ...pr }));
} else {
  const n = /^\\d+$/.test(a[2] ?? '') ? Number(a[2]) : s.branchPr;
  if (!s.prs[n] && !(n === s.branchPr)) { process.stderr.write('no pull requests found'); process.exit(1); }
  process.stdout.write(JSON.stringify({ number: n, url: 'https://github.com/o/r/pull/' + n }));
}
`, { mode: 0o755 });
process.env.REMOTE_IDE_CONFIG_DIR = dir;
process.env.AIE_GH_BIN = ghBin;
const setGh = (s: any) => fs.writeFileSync(stateFile, JSON.stringify(s));

type Svc = typeof import('../watch-service.js');
let svc: Svc;
let store: typeof import('../store.js');
let pr: typeof import('../changes-pr.js');
const delivered: { sessionId: string; text: string }[] = [];
const uid = 'u1';
const who = (sessionId: string) => ({ sessionId, projectId: 'p', projectPath: dir, cwd: dir });

beforeAll(async () => {
  fs.mkdirSync(path.join(dir, 'users', uid), { recursive: true });
  svc = await import('../watch-service.js');
  store = await import('../store.js');
  pr = await import('../changes-pr.js');
  svc.configureWatches({ deliver: async (_u, w, text) => { delivered.push({ sessionId: w.sessionId, text }); }, changed: () => {} });
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  delivered.length = 0;
  pr.clearPrCache();
  await store.putWatches(uid, {});
});
const settle = () => vi.waitFor(() => { if (delivered.length === 0) throw new Error('not yet'); }, { timeout: 3000 });

describe('watch service', () => {
  it('resolves the PR of the branch, waits while open, delivers once merged', async () => {
    setGh({ branchPr: 7, prs: { 7: { state: 'OPEN' } } });
    const w = await svc.addWatch(uid, who('s1'), { kind: 'pr_merged', then: 'clean up' });
    expect(w).toMatchObject({ label: 'PR #7 merged', condition: { kind: 'pr_merged', repo: 'o/r', pr: 7 } });
    await svc.checkWatchesNow();
    expect((await svc.watchesOf(uid, 's1'))[0]).toMatchObject({ lastSeen: 'open', checks: 1 });
    expect(delivered).toEqual([]);

    setGh({ branchPr: 7, prs: { 7: { state: 'MERGED', mergeCommit: { oid: 'e41841c36a61a7397adfa2634822a8acc7b10341' } } } });
    pr.clearPrCache();
    await svc.checkWatchesNow();
    await settle();
    expect(delivered[0].sessionId).toBe('s1');
    expect(delivered[0].text).toMatch(/^\[Watch "PR #7 merged" met\]\n\nPR #7 "PR 7" was merged \(merge commit e41841c\)\.\n\nWhen you set this watch you planned to: clean up/);
    expect(await svc.watchesOf(uid)).toEqual([]);
    expect(await store.getWatches(uid)).toEqual({});
  });

  it('shares one look at a PR between sessions, and tells each', async () => {
    setGh({ prs: { 9: { state: 'CLOSED' } } });
    await svc.addWatch(uid, who('a'), { kind: 'pr_merged', pr: 9 });
    await svc.addWatch(uid, who('b'), { kind: 'pr_merged', pr: 9 });
    await svc.checkWatchesNow();
    await vi.waitFor(() => { if (delivered.length < 2) throw new Error('not yet'); }, { timeout: 3000 });
    expect(delivered.map((d) => d.sessionId).sort()).toEqual(['a', 'b']);
    expect(delivered[0].text).toMatch(/cannot be met\]\n\nPR #9 "PR 9" was closed without being merged/);
  });

  it('a reply ends the watches set before it, not those set after', async () => {
    setGh({ prs: { 3: { state: 'OPEN' } } });
    const a = await svc.addWatch(uid, who('s'), { kind: 'pr_merged', pr: 3 });
    const replyAt = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.addWatch(uid, who('s'), { kind: 'pr_checks', pr: 3 });
    const gone = await svc.cancelWatches(uid, 's', { before: replyAt });
    expect(gone.map((w) => w.id)).toEqual([(a as any).id]);
    expect((await svc.watchesOf(uid, 's')).map((w) => w.id)).toEqual([(b as any).id]);
  });

  it('a watch settled but cancelled before delivery is not delivered', async () => {
    const w = { id: 'x1', sessionId: 's', projectId: 'p', projectPath: dir, condition: { kind: 'pr_merged', repo: 'o/r', pr: 3 }, label: 'PR #3 merged', then: '', createdAt: 1, deadline: Date.now() + 1e6, nextCheckAt: 0, checks: 1, lastSeen: '', outcome: { kind: 'met', text: 'merged' } };
    await store.putWatches(uid, { x1: w as any });
    await svc.cancelWatches(uid, 's');
    await svc.startWatches();
    await new Promise((r) => setTimeout(r, 300));
    expect(delivered).toEqual([]);
  });

  it('delivers on start what settled before a restart', async () => {
    const w = { id: 'r1', sessionId: 's9', projectId: 'p', projectPath: dir, condition: { kind: 'pr_merged', repo: 'o/r', pr: 3 }, label: 'PR #3 merged', then: 'deploy', createdAt: 1, deadline: Date.now() + 1e6, nextCheckAt: 0, checks: 1, lastSeen: '', outcome: { kind: 'met', text: 'PR #3 was merged.' } };
    await store.putWatches(uid, { r1: w as any });
    setGh({ prs: {} });
    await svc.startWatches();
    await settle();
    expect(delivered[0]).toEqual({ sessionId: 's9', text: expect.stringMatching(/^\[Watch "PR #3 merged" met\]\n\nPR #3 was merged\.\n\nWhen you set this watch you planned to: deploy/) });
  });

  it('deployed: met when the running code includes the commit', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../../..') }).toString().trim();
    await svc.addWatch(uid, who('d'), { kind: 'deployed', commit: head.slice(0, 12) });
    await svc.addWatch(uid, who('e'), { kind: 'deployed', commit: 'deadbeefdeadbeef' });
    await svc.checkWatchesNow();
    await settle();
    expect(delivered.map((d) => d.sessionId)).toEqual(['d']);
    expect(delivered[0].text).toMatch(/is now running code that includes/);
    expect((await svc.watchesOf(uid, 'e'))[0].lastSeen).toMatch(/does not include deadbee yet/);
  });

  it('times out', async () => {
    setGh({ prs: { 4: { state: 'OPEN' } } });
    const w = await svc.addWatch(uid, who('t'), { kind: 'pr_merged', pr: 4, timeoutHours: 0.0000001 });
    expect('id' in w).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await svc.checkWatchesNow();
    await settle();
    expect(delivered[0].text).toMatch(/^\[Watch "PR #4 merged" timed out\][\s\S]*Last seen: open\./);
  });

  it('refuses bad input and too many watches', async () => {
    setGh({ prs: { 5: { state: 'OPEN' } } });
    expect(await svc.addWatch(uid, who('z'), { kind: 'deployed', commit: 'not a sha' })).toEqual({ error: '"not a sha" is not a commit hash.' });
    expect(await svc.addWatch(uid, who('z'), { kind: 'pr_merged', pr: 404 })).toMatchObject({ error: expect.stringMatching(/^Could not find PR #404/) });
    for (let i = 0; i < 5; i++) expect('id' in (await svc.addWatch(uid, who('z'), { kind: 'pr_merged', pr: 5 }) as any)).toBe(true);
    expect(await svc.addWatch(uid, who('z'), { kind: 'pr_merged', pr: 5 })).toMatchObject({ error: expect.stringMatching(/already has 5 watches/) });
  });
});
