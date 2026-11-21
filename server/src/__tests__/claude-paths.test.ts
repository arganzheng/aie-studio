import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeDirName, claudeProjectDir, findTranscript, transcriptFile } from '../claude-paths.js';

describe('claudeDirName', () => {
  it('replaces every non-alphanumeric character, as Claude Code does', () => {
    expect(claudeDirName('/Users/me/Code/me.github.com')).toBe('-Users-me-Code-me-github-com');
    expect(claudeDirName('/p/.claude/worktrees/add-x')).toBe('-p--claude-worktrees-add-x');
    expect(claudeDirName('/a b/c_d')).toBe('-a-b-c-d');
  });
});

describe('transcript lookup', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aie-cp-')));
  const home = path.join(base, 'home');
  const proj = path.join(base, 'my.proj');
  const link = path.join(base, 'link');
  fs.mkdirSync(proj, { recursive: true });
  fs.symlinkSync(proj, link);
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('resolves symlinks before naming the directory', () => {
    expect(claudeProjectDir(link, home)).toBe(claudeProjectDir(proj, home));
    expect(path.basename(claudeProjectDir(proj, home))).toBe(claudeDirName(proj));
  });

  it("finds a transcript where Claude Code wrote it, then by searching", async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const file = transcriptFile(proj, sid, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    expect(await findTranscript(link, sid, home)).toBe(file);

    const other = '99999999-2222-4333-8444-555555555555';
    const elsewhere = path.join(home, '.claude', 'projects', 'some-hashed-name', `${other}.jsonl`);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '{}\n');
    expect(await findTranscript(proj, other, home)).toBe(elsewhere);
  });

  it('returns null for a missing session and refuses odd ids', async () => {
    expect(await findTranscript(proj, '00000000-0000-4000-8000-000000000000', home)).toBeNull();
    expect(await findTranscript(proj, '../../etc/passwd', home)).toBeNull();
  });
});
