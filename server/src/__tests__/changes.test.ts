import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseUnifiedDiff, pickBaseBranch, readChanges, untrackedFile } from '../changes.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
+two and a half
 three
@@ -10,2 +10,1 @@ function x() {
 ten
-eleven
\\ No newline at end of file
diff --git a/new.md b/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.md
@@ -0,0 +1,2 @@
+# New
+--- not a header
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/x.ts b/y.ts
similarity index 90%
rename from x.ts
rename to y.ts
index 5555555..6666666 100644
--- a/x.ts
+++ b/y.ts
@@ -1 +1 @@
-a
+b
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(DIFF);

  it('reads each file with its status and counts', () => {
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ['src/a.ts', 'modified', 2, 2, false],
      ['new.md', 'added', 2, 0, false],
      ['old.txt', 'deleted', 0, 1, false],
      ['y.ts', 'renamed', 1, 1, false],
      ['logo.png', 'modified', 0, 0, true],
    ]);
    expect(files[3].oldPath).toBe('x.ts');
  });

  it('numbers old and new lines across hunks', () => {
    const [h1, h2] = files[0].hunks;
    expect(h1.lines).toEqual([
      { t: ' ', text: 'one', oldNo: 1, newNo: 1 },
      { t: '-', text: 'two', oldNo: 2 },
      { t: '+', text: 'TWO', newNo: 2 },
      { t: '+', text: 'two and a half', newNo: 3 },
      { t: ' ', text: 'three', oldNo: 3, newNo: 4 },
    ]);
    expect(h2.header).toBe('@@ -10,2 +10,1 @@ function x() {');
    expect(h2.lines.map((l) => l.t)).toEqual([' ', '-', '\\']);
  });

  it('keeps a "---" line inside a hunk as content', () => {
    expect(files[1].hunks[0].lines[1]).toEqual({ t: '+', text: '--- not a header', newNo: 2 });
  });

  it('cuts long files but keeps the full counts', () => {
    const big = `diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1,5 @@\n${'+x\n'.repeat(5)}`;
    const [f] = parseUnifiedDiff(big, { file: 2, total: 100 });
    expect(f.additions).toBe(5);
    expect(f.hunks[0].lines).toHaveLength(2);
    expect(f.truncated).toBe(true);
  });
});

describe('untrackedFile', () => {
  it('adds every line', () => {
    const f = untrackedFile('n.txt', 'a\nb\n');
    expect(f).toMatchObject({ status: 'untracked', additions: 2, binary: false });
    expect(f.hunks[0].lines).toEqual([{ t: '+', text: 'a', newNo: 1 }, { t: '+', text: 'b', newNo: 2 }]);
  });
  it('marks binary and cut files', () => {
    expect(untrackedFile('x.bin', null).binary).toBe(true);
    expect(untrackedFile('big.txt', 'a\n', true).truncated).toBe(true);
  });
});

describe('pickBaseBranch', () => {
  it("prefers the local copy of the remote's default branch", () => {
    expect(pickBaseBranch(['main', 'dev', 'origin/main', 'origin/dev'], 'origin/dev')).toBe('dev');
    expect(pickBaseBranch(['feature', 'origin/trunk'], 'origin/trunk')).toBe('origin/trunk');
  });
  it('falls back to main, then master', () => {
    expect(pickBaseBranch(['master', 'feature'], null)).toBe('master');
    expect(pickBaseBranch(['main', 'master'], null)).toBe('main');
    expect(pickBaseBranch(['feature'], null)).toBeNull();
  });
});

describe('readChanges (real git repo)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aie-changes-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('shows commits since the main branch plus uncommitted and untracked work', async () => {
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
    g('commit', '-q', '-am', 'change');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    fs.mkdirSync(path.join(dir, '.claude', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'worktrees', 'w1', 'skip.txt'), 'x\n');

    const all = await readChanges(dir, null, 'base');
    expect(all).toMatchObject({ branch: 'feature', base: 'main', ahead: 1, dirty: 1 });
    expect(all.files.map((f) => [f.path, f.status])).toEqual([['a.txt', 'modified'], ['b.txt', 'untracked']]);

    const now = await readChanges(dir, null, 'uncommitted');
    expect(now.files.map((f) => f.path)).toEqual(['b.txt']);
  });
});

describe('new versions', () => {
  it('counts lines with or without a final newline', async () => {
    const { countLines } = await import('../changes.js');
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });
  it('keeps paths inside the checkout', async () => {
    const { insideCheckout } = await import('../changes.js');
    expect(insideCheckout('/r', 'a/b.md')).toBe('/r/a/b.md');
    expect(insideCheckout('/r', '../x')).toBeNull();
    expect(insideCheckout('/r', '/etc/passwd')).toBeNull();
    expect(insideCheckout('/r', '')).toBeNull();
  });
});
