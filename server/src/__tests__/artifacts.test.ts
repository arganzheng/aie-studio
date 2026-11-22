import { describe, expect, it } from 'vitest';
import { ATTACHED_HEAD, attachedPaths, ownAttachment, sessionArtifacts, transcriptImage } from '../artifacts.js';
import fs from 'node:fs';

// The web writes the marker (web/src/lib/fileAttachments.ts); read it as text, it is another package.
const WEB_HEAD = /ATTACHED_HEAD = '([^']+)'/.exec(fs.readFileSync(new URL('../../../web/src/lib/fileAttachments.ts', import.meta.url), 'utf8'))?.[1];

const use = (name: string, input: object, ts = '2026-11-22T10:00:00Z') => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: name + JSON.stringify(input), name, input }] } });
const user = (text: string, ts = '2026-11-22T09:00:00Z') => ({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text }] } });

describe('session artifacts', () => {
  it('the prompt marker is the one the web writes', () => {
    expect(ATTACHED_HEAD).toBe(WEB_HEAD);
  });
  it('reads attached paths from a prompt', () => {
    expect(attachedPaths(`Look at these\n\n${ATTACHED_HEAD}\n- /c/uploads/u/ab/a.png\n- /c/uploads/u/cd/b.pdf`)).toEqual(['/c/uploads/u/ab/a.png', '/c/uploads/u/cd/b.pdf']);
    expect(attachedPaths('no files here')).toEqual([]);
  });
  it('lists files written (project-relative, newest first, created vs edited) and attachments', () => {
    const r = sessionArtifacts([
      user(`hi\n\n${ATTACHED_HEAD}\n- /c/uploads/u/ab/shot.png`),
      use('Write', { file_path: '/p/src/new.ts' }, '2026-11-22T10:00:00Z'),
      use('Edit', { file_path: '/p/README.md' }, '2026-11-22T10:01:00Z'),
      use('Edit', { file_path: '/p/src/new.ts' }, '2026-11-22T10:02:00Z'),
      use('NotebookEdit', { notebook_path: '/tmp/x.ipynb' }, '2026-11-22T10:03:00Z'),
      use('Read', { file_path: '/p/other.ts' }),
    ], '/p/');
    expect(r.files).toEqual([
      { path: '/tmp/x.ipynb', inProject: false, created: false, edits: 1, lastAt: '2026-11-22T10:03:00Z' },
      { path: 'src/new.ts', inProject: true, created: true, edits: 2, lastAt: '2026-11-22T10:02:00Z' },
      { path: 'README.md', inProject: true, created: false, edits: 1, lastAt: '2026-11-22T10:01:00Z' },
    ]);
    expect(r.attachments).toEqual([{ kind: 'file', path: '/c/uploads/u/ab/shot.png', name: 'shot.png', at: '2026-11-22T09:00:00Z' }]);
  });
  it('a sibling directory with the same prefix is outside the project', () => {
    expect(sessionArtifacts([use('Write', { file_path: '/p2/a.ts' })], '/p').files[0]).toMatchObject({ path: '/p2/a.ts', inProject: false });
  });
  it('only your own attachments can be read back', () => {
    expect(ownAttachment('/c/uploads', 'u1', '/c/uploads/u1/ab/a.png')).toBe(true);
    expect(ownAttachment('/c/uploads', 'u1', '/c/uploads/u2/ab/a.png')).toBe(false);
    expect(ownAttachment('/c/uploads', 'u1', '/c/uploads/u1/../u2/ab/a.png')).toBe(false);
    expect(ownAttachment('/c/uploads', 'u1', '/etc/passwd')).toBe(false);
    expect(ownAttachment('/c/uploads', 'u1', 'u1/ab/a.png')).toBe(false);
    expect(ownAttachment('/c/uploads', '../x', '/c/uploads/../x/a')).toBe(false);
  });
});

describe('files written by a shell command', () => {
  it('finds redirect and tee targets, not heredoc bodies or /dev/null', async () => {
    const { shellWrites } = await import('../artifacts.js');
    expect(shellWrites("cat > src/notes.ts <<'EOF'\nconst a = b > c;\necho x > nope.txt\nEOF\necho hi >> README.md 2>/dev/null")).toEqual(['src/notes.ts', 'README.md']);
    expect(shellWrites('npm test 2>&1 | tee out/log.txt')).toEqual(['out/log.txt']);
    expect(shellWrites('ls > $OUT/x; cat a > "$(date)"')).toEqual([]);
    expect(shellWrites('if [ $a -gt 1 ]; then echo; fi')).toEqual([]);
  });
  it('a shell write counts, and a later file tool clears "via shell"', () => {
    const r = sessionArtifacts([
      { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'printf x > /p/a.txt' } }] } },
      { type: 'assistant', timestamp: 't2', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo y > b.txt' } }] } },
      use('Edit', { file_path: '/p/a.txt' }, 't3'),
    ], '/p');
    expect(r.files).toEqual([
      { path: 'a.txt', inProject: true, created: false, edits: 2, lastAt: 't3' },
      { path: 'b.txt', inProject: true, created: false, edits: 1, lastAt: 't2', viaShell: true },
    ]);
  });
});

describe('pasted images', () => {
  const png = Buffer.from('fake-png').toString('base64');
  const msgs = [
    { type: 'user', timestamp: 't1', message: { content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/p/x.png' } }] } },
    // A tool's image result is not something the user attached.
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', content: [] }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    { type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: png } }] } },
  ];
  it('lists images the user pasted, by ref', () => {
    expect(sessionArtifacts(msgs, '/p').attachments).toEqual([{ kind: 'image', ref: '0.1', name: 'Pasted image 1', mediaType: 'image/png', at: 't1' }]);
  });
  it('reads one back; nothing else', () => {
    expect(transcriptImage(msgs, '0.1')?.data.toString()).toBe('fake-png');
    expect(transcriptImage(msgs, '0.0')).toBeNull();
    expect(transcriptImage(msgs, '3.0')).toBeNull();
    expect(transcriptImage(msgs, '1.0')).toBeNull();
    expect(transcriptImage(msgs, '../x')).toBeNull();
  });
});
