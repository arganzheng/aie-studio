import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, isWorktreeName, removeWorktreeIfClean, worktreeNameOf, worktreeNote, worktreeSlug, worktreeStatus } from '../worktrees.js';
import { childReport, worktreePreface } from '../child-sessions.js';

describe('worktree names', () => {
  it('makes a git- and path-safe slug with a unique tail', () => {
    expect(worktreeSlug('Draft Apple Pay tests', 'x7k2')).toBe('draft-apple-pay-tests-x7k2');
    expect(worktreeSlug('  修复 / login?? ', 'ab')).toBe('login-ab');
    expect(worktreeSlug('!!!', '')).toBe('child-x');
    expect(worktreeSlug('a'.repeat(100), 'zz').length).toBeLessThanOrEqual(43);
    expect(isWorktreeName(worktreeSlug('Draft Apple Pay tests', 'x7k2'))).toBe(true);
  });
  it('rejects names that could leave the worktrees directory', () => {
    for (const bad of ['', '../x', 'a/b', '.hidden', 'UPPER', 'a b']) expect(isWorktreeName(bad)).toBe(false);
  });
  it('recognises a path inside the project\'s worktrees directory', () => {
    expect(worktreeNameOf('/w/app', '/w/app/.claude/worktrees/draft-x1')).toBe('draft-x1');
    expect(worktreeNameOf('/w/app', '/w/app/.claude/worktrees/draft-x1/src')).toBe('draft-x1');
    expect(worktreeNameOf('/w/app', '/w/app')).toBeNull();
    expect(worktreeNameOf('/w/app', '/w/app-other/.claude/worktrees/x')).toBeNull();
    expect(worktreeNameOf('/w/app', '/w/elsewhere')).toBeNull();
  });
});

describe('worktree wording', () => {
  it('tells the parent what there is to merge', () => {
    expect(worktreeNote({ name: 'draft-x1', branch: 'child/draft-x1', ahead: 2, dirty: 0 }))
      .toBe('Worktree: this child worked in .claude/worktrees/draft-x1 on branch child/draft-x1 — 2 new commits, nothing uncommitted. To keep its work, merge or cherry-pick branch child/draft-x1 into your branch.');
    expect(worktreeNote({ name: 'n', branch: 'child/n', ahead: 0, dirty: 3 })).toContain('3 uncommitted files');
    expect(worktreeNote({ name: 'n', branch: 'child/n', ahead: 0, dirty: 3 })).toContain('have the child commit them first');
    expect(worktreeNote({ name: 'n', branch: 'child/n', ahead: 0, dirty: 0 })).toContain('It changed nothing there.');
  });
  it('puts the note in the report, after the answer', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: true, result: 'Done.', worktreeNote: 'Worktree: on branch child/n.' });
    expect(text).toContain('Done.\n\nWorktree: on branch child/n.\n\n(Sent automatically');
  });
  it('briefs the child about its worktree', () => {
    const p = worktreePreface({ path: '/w/app/.claude/worktrees/n', branch: 'child/n', projectPath: '/w/app' });
    expect(p).toContain('on branch child/n');
    expect(p).toContain('do not modify the main checkout at /w/app');
  });
});

describe('worktrees on a real repository', () => {
  let repo = '';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString();
  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aie-wt-test-')));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  });
  afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

  it('creates a worktree on its own branch and keeps it out of git status', async () => {
    const wt = await createWorktree(repo, repo, 'Draft tests');
    expect(wt.branch).toBe(`child/${wt.name}`);
    expect(fs.existsSync(path.join(wt.path, 'a.txt'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(await worktreeStatus(repo, wt.name)).toEqual({ name: wt.name, branch: wt.branch, ahead: 0, dirty: 0 });
    // clean and nothing to merge: goes away, branch too
    expect(await removeWorktreeIfClean(repo, wt.name)).toEqual({ removed: true });
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(repo, 'branch', '--list', wt.branch).trim()).toBe('');
  });

  it('keeps a worktree that has uncommitted or unmerged work', async () => {
    const wt = await createWorktree(repo, repo, 'Edit a');
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'two\n');
    expect(await worktreeStatus(repo, wt.name)).toMatchObject({ ahead: 0, dirty: 1 });
    expect(await removeWorktreeIfClean(repo, wt.name)).toMatchObject({ removed: false, reason: '1 uncommitted file' });
    git(wt.path, 'commit', '-q', '-am', 'edit');
    expect(await worktreeStatus(repo, wt.name)).toMatchObject({ ahead: 1, dirty: 0 });
    const kept = await removeWorktreeIfClean(repo, wt.name);
    expect(kept.removed).toBe(false);
    expect(kept.reason).toContain("1 commit that isn't merged");
    // once merged, nothing is lost by removing it
    git(repo, 'merge', '-q', wt.branch);
    expect(await removeWorktreeIfClean(repo, wt.name)).toEqual({ removed: true });
  });

  it('branches a child of a child from the parent worktree, not from main', async () => {
    const parent = await createWorktree(repo, repo, 'Parent');
    fs.writeFileSync(path.join(parent.path, 'p.txt'), 'p\n');
    git(parent.path, 'add', '-A'); git(parent.path, 'commit', '-q', '-m', 'p');
    const child = await createWorktree(repo, parent.path, 'Grandchild');
    expect(fs.existsSync(path.join(child.path, 'p.txt'))).toBe(true);
  });

  it('refuses outside a git repository, saying why', async () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aie-wt-plain-')));
    await expect(createWorktree(plain, plain, 'x')).rejects.toThrow(/not a git repository/);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
