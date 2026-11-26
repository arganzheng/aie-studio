import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjectFiles, parseFileList } from '../project-files.js';

describe('parseFileList', () => {
  it('splits on NUL, drops deleted files and duplicates', () => {
    expect(parseFileList('a.ts\0src/b c.ts\0a.ts\0gone.ts\0', 'gone.ts\0')).toEqual({ files: ['a.ts', 'src/b c.ts'], truncated: false });
  });
  it('cuts a huge list and says so', () => {
    expect(parseFileList('a\0b\0c\0', '', 2)).toEqual({ files: ['a', 'b'], truncated: true });
  });
});

describe('listProjectFiles', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aie-files-'));
  const write = (dir: string, rel: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), 'x'); };

  it('git checkout: tracked and new files, not ignored or deleted ones', async () => {
    const dir = tmp();
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
    g('init', '-q');
    for (const f of ['README.md', 'src/a.ts', 'src/old.ts', '.gitignore']) write(dir, f);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    write(dir, 'src/new file.ts');
    write(dir, 'node_modules/x/index.js');
    write(dir, 'dist/out.js');
    fs.rmSync(path.join(dir, 'src/old.ts'));
    const r = await listProjectFiles(dir);
    expect(r.truncated).toBe(false);
    expect([...r.files].sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts', 'src/new file.ts']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('not a git checkout: walks, skipping dot directories and node_modules', async () => {
    const dir = tmp();
    for (const f of ['b.txt', 'a/c.txt', '.cache/x', 'node_modules/y/z.js']) write(dir, f);
    expect((await listProjectFiles(dir)).files).toEqual(['b.txt', 'a/c.txt']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
