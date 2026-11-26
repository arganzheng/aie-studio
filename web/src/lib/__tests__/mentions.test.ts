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
