import { describe, expect, it } from 'vitest';
import { fileItems, fileMentionResolver, fileMentionText, findMentions, matchMentionQuery, rankFiles } from '../mentions';

describe('matchMentionQuery', () => {
  it('opens on "@" at the start or after whitespace', () => {
    expect(matchMentionQuery('@')).toEqual({ from: 0, query: '' });
    expect(matchMentionQuery('look at @src/ma')).toEqual({ from: 8, query: 'src/ma' });
    expect(matchMentionQuery('line one\n@re')).toEqual({ from: 9, query: 're' });
  });
  it('stays closed inside a word, after whitespace, or with no "@"', () => {
    expect(matchMentionQuery('me@example')).toBeNull();
    expect(matchMentionQuery('@src/a.ts ')).toBeNull();
    expect(matchMentionQuery('plain text')).toBeNull();
    expect(matchMentionQuery('')).toBeNull();
  });
});

describe('fileMentionText', () => {
  it('quotes paths with whitespace', () => {
    expect(fileMentionText('src/a.ts')).toBe('@src/a.ts');
    expect(fileMentionText('docs/my notes.md')).toBe('@"docs/my notes.md"');
  });
});

const FILES = ['README.md', 'src/math.ts', 'src/deep/mathUtils.ts', 'docs/readme-old.md', 'todo.txt', 'web/src/components/Chat.tsx'];

describe('rankFiles', () => {
  it('no query: shallowest first', () => {
    expect(rankFiles(FILES, '').slice(0, 2)).toEqual(['README.md', 'todo.txt']);
  });
  it('name match beats path match; exact beats prefix beats inside', () => {
    expect(rankFiles(FILES, 'math')).toEqual(['src/math.ts', 'src/deep/mathUtils.ts']);
    expect(rankFiles(FILES, 'readme')).toEqual(['README.md', 'docs/readme-old.md']);
    expect(rankFiles(FILES, 'src')).toEqual(['src/math.ts', 'src/deep/mathUtils.ts', 'web/src/components/Chat.tsx']);
  });
  it('falls back to letters in order, and drops what does not match', () => {
    expect(rankFiles(FILES, 'wchat')).toEqual(['web/src/components/Chat.tsx']);
    expect(rankFiles(FILES, 'zzz')).toEqual([]);
  });
  it('respects the limit', () => {
    expect(rankFiles(FILES, '', 3)).toHaveLength(3);
  });
});

describe('fileItems', () => {
  it('shows the name, the directory, and inserts the mention with a space', () => {
    expect(fileItems(FILES, 'chat')[0]).toEqual({ group: 'Files', name: 'web/src/components/Chat.tsx', label: 'Chat.tsx', description: 'web/src/components', insert: '@web/src/components/Chat.tsx ' });
    expect(fileItems(['a b.txt'], '')[0].insert).toBe('@"a b.txt" ');
  });
});

describe('findMentions', () => {
  const resolve = fileMentionResolver(new Set([...FILES, 'docs/my notes.md']));
  const found = (text: string) => findMentions(text, resolve).map((r) => [text.slice(r.from, r.to), r.info.label]);
  it('finds known files only', () => {
    expect(found('see @src/math.ts and @nobody, mail me@src/math.ts')).toEqual([['@src/math.ts', 'math.ts']]);
  });
  it('handles quoted paths, line starts and several per line', () => {
    expect(found('@"docs/my notes.md" then\n@todo.txt @README.md')).toEqual([['@"docs/my notes.md"', 'my notes.md'], ['@todo.txt', 'todo.txt'], ['@README.md', 'README.md']]);
  });
  it('leaves sentence punctuation outside the mention', () => {
    expect(found('fix @src/math.ts, then (@todo.txt). 看 @README.md。')).toEqual([['@src/math.ts', 'math.ts'], ['@README.md', 'README.md']]);
  });
});

import { combineResolvers, expandMentions, openTarget, sessionItems, sessionMentionResolver, sessionMentionText, sessionSendText, type MentionSession } from '../mentions';

describe('session mentions', () => {
  const NOW = 1_800_000_000_000;
  const A: MentionSession = { id: '11111111-aaaa', title: 'Fix the "login" bug', kind: 'claude', updatedAt: NOW - 60_000 };
  const B: MentionSession = { id: 'devin-slug-22', title: 'Blog figures', kind: 'devin', updatedAt: NOW - 3_600_000 };
  const sessions = new Map([[A.id, A], [B.id, B]]);
  const resolve = combineResolvers(sessionMentionResolver(sessions), fileMentionResolver(new Set(['todo.txt'])))!;

  it('is "@session:<id>" in the text and a titled chip', () => {
    expect(sessionMentionText(A.id)).toBe('@session:11111111-aaaa');
    const [m] = findMentions(`see @session:${A.id} please`, resolve);
    expect(m.info).toMatchObject({ kind: 'session', label: 'Fix the "login" bug' });
    expect(findMentions('@session:unknown-id-1', resolve)).toEqual([]);
  });
  it('is sent as a line with the title and the id; files are sent as they are', () => {
    expect(sessionSendText(A)).toBe(`[session "Fix the 'login' bug" (Claude, id 11111111-aaaa)]`);
    expect(expandMentions(`compare @session:${A.id} with @session:${B.id}, and @todo.txt.`, resolve))
      .toBe(`compare [session "Fix the 'login' bug" (Claude, id 11111111-aaaa)] with [session "Blog figures" (Devin, id devin-slug-22)], and @todo.txt.`);
    expect(expandMentions('nothing here', resolve)).toBe('nothing here');
    expect(expandMentions('@session:x', null)).toBe('@session:x');
  });
  it('picker rows: latest first, filtered by title, with kind and age', () => {
    const rows = sessionItems([B, A], '', NOW);
    expect(rows.map((r) => r.label)).toEqual(['Fix the "login" bug', 'Blog figures']);
    expect(rows[0]).toMatchObject({ group: 'Sessions', name: A.id, insert: `@session:${A.id} ` });
    expect(rows[1].description.startsWith('Devin · ')).toBe(true);
    expect(sessionItems([A, B], 'blog', NOW).map((r) => r.name)).toEqual([B.id]);
    expect(sessionItems([A, B], 'zzz', NOW)).toEqual([]);
  });
  it('chips say what a click opens', () => {
    expect(findMentions('@todo.txt', resolve)[0].info.open).toBe('file:todo.txt');
    expect(findMentions(`@session:${A.id}`, resolve)[0].info.open).toBe(`session:${A.id}`);
    expect(openTarget('file:src/a b.ts')).toEqual({ kind: 'file', path: 'src/a b.ts' });
    expect(openTarget(`session:${A.id}`)).toEqual({ kind: 'session', id: A.id });
    expect(openTarget('other')).toBeNull();
  });
  it('combineResolvers: null when there is none', () => {
    expect(combineResolvers(null, null)).toBeNull();
  });
});
