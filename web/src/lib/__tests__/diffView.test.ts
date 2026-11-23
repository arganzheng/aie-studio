import { describe, expect, it } from 'vitest';
import type { ChangesResult, DiffFile } from '../../api';
import { fileGaps, gapView, keepUnchangedFiles, pairWordDiffs, splitPath, tokenize, wordDiff } from '../diffView';

const changed = (segs: { text: string; changed: boolean }[]) => segs.filter((s) => s.changed).map((s) => s.text);

describe('wordDiff', () => {
  it('marks the changed word in English', () => {
    const d = wordDiff('const a = foo(1);', 'const a = bar(1);')!;
    expect(changed(d.old)).toEqual(['foo']);
    expect(changed(d.new)).toEqual(['bar']);
    expect(d.new.map((s) => s.text).join('')).toBe('const a = bar(1);');
  });
  it('marks inserted Chinese characters one by one, not the whole line', () => {
    const d = wordDiff('同一条 import 语句会 dlopen 它并调用', '同一条 import 语句会用 dlopen （操作系统提供的函数）加载它，并调用')!;
    expect(changed(d.old)).toEqual([]);
    expect(changed(d.new).join('')).toBe('用（操作系统提供的函数）加载，');
  });
  it('gives up on lines with little in common', () => {
    expect(wordDiff('the quick brown fox', 'completely different text here')).toBeNull();
  });
  it('tokenizes words, spaces and CJK characters', () => {
    expect(tokenize('ab  中文!')).toEqual(['ab', '  ', '中', '文', '!']);
  });
});

describe('pairWordDiffs', () => {
  it('pairs the n-th removed line with the n-th added one', () => {
    const m = pairWordDiffs([
      { t: ' ', text: 'x', oldNo: 1, newNo: 1 },
      { t: '-', text: 'let a = 1', oldNo: 2 },
      { t: '-', text: 'let b = 2', oldNo: 3 },
      { t: '+', text: 'let a = 10', newNo: 2 },
      { t: '+', text: 'let b = 20', newNo: 3 },
      { t: '+', text: 'let c = 3', newNo: 4 },
    ]);
    expect([...m.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(changed(m.get(3)!)).toEqual(['10']);
  });
});

const file = (over: Partial<DiffFile>): DiffFile => ({ path: 'a.md', status: 'modified', binary: false, additions: 1, deletions: 1, hunks: [], ...over });

describe('fileGaps', () => {
  it('finds the stretches before, between and after hunks', () => {
    const f = file({
      hunks: [
        { header: '@@ -11,4 +11,4 @@', lines: [
          { t: ' ', text: 'a', oldNo: 11, newNo: 11 },
          { t: '-', text: 'b', oldNo: 12 },
          { t: '+', text: 'b2', newNo: 12 },
          { t: '+', text: 'b3', newNo: 13 },
          { t: ' ', text: 'c', oldNo: 13, newNo: 14 },
        ] },
        { header: '@@ -50,1 +51,1 @@', lines: [{ t: ' ', text: 'z', oldNo: 50, newNo: 51 }] },
      ],
    });
    expect(fileGaps(f, 100)).toEqual([
      { before: 0, from: 1, to: 10, oldOffset: 0 },
      { before: 1, from: 15, to: 50, oldOffset: -1 },
      { before: 2, from: 52, to: 100, oldOffset: -1 },
    ]);
  });
  it('leaves out the end when the file ends with the last hunk', () => {
    const f = file({ hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [{ t: '-', text: 'a', oldNo: 1 }, { t: '+', text: 'b', newNo: 1 }, { t: ' ', text: 'c', oldNo: 2, newNo: 2 }] }] });
    expect(fileGaps(f, 2)).toEqual([]);
    expect(fileGaps(f)).toEqual([{ before: 1, from: 3, to: null, oldOffset: 0 }]);
  });
  it('has none for added, deleted or cut-short files', () => {
    const h = [{ header: '@@ -0,0 +1,1 @@', lines: [{ t: '+' as const, text: 'a', newNo: 1 }] }];
    expect(fileGaps(file({ status: 'added', hunks: h }), 1)).toEqual([]);
    expect(fileGaps(file({ truncated: true, hunks: h }), 10)).toEqual([]);
  });
});

describe('gapView', () => {
  const gap = { before: 1, from: 15, to: 50, oldOffset: -1 };
  it('opens from the top and the bottom', () => {
    const v = gapView(gap, { top: 2, bottom: 3 }, null);
    expect(v).toEqual({ top: [15, 16], bottom: [48, 49, 50], hidden: 31 });
  });
  it('never shows a line twice', () => {
    const v = gapView(gap, { top: 30, bottom: 30 }, null);
    expect(v.top.length + v.bottom.length).toBe(36);
    expect(v.hidden).toBe(0);
  });
  it('waits for the file length when the end is unknown', () => {
    expect(gapView({ ...gap, to: null }, { top: 5, bottom: 0 }, null).hidden).toBeNull();
    expect(gapView({ ...gap, to: null }, { top: 5, bottom: 0 }, 30).hidden).toBe(11);
  });
});

describe('splitPath / keepUnchangedFiles', () => {
  it('splits name and directory', () => {
    expect(splitPath('_posts/2026-a.md')).toEqual({ name: '2026-a.md', dir: '_posts' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });
  it('keeps unchanged files as the same objects', () => {
    const base = { git: true as const, scope: 'base' as const, worktree: null, branch: 'b', base: 'main', mergeBase: null, ahead: 0, dirty: 0 };
    const prev: ChangesResult = { ...base, files: [file({ path: 'a' }), file({ path: 'b' })] };
    const next: ChangesResult = { ...base, files: [file({ path: 'a' }), file({ path: 'b', additions: 5 })] };
    const r = keepUnchangedFiles(prev, next);
    if (!r.git || !prev.git) throw new Error();
    expect(r.files[0]).toBe(prev.files[0]);
    expect(r.files[1]).not.toBe(prev.files[1]);
    const same = keepUnchangedFiles(prev, { ...base, files: [file({ path: 'a' }), file({ path: 'b' })] });
    if (!same.git) throw new Error();
    expect(same.files).toBe(prev.files);
  });
});
