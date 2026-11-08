import { describe, it, expect } from 'vitest';
import type { Bookmark } from '../../types';
import { bookmarkLabel, bookmarkedAnchorsFor, findBookmark, removeBookmark, toggleBookmark } from '../review';

const s1 = { type: 'session', key: 's1' };
const d1 = { type: 'devin', key: 'd1' };
const mk = (id: string, tab = s1, anchor = `u:${id}`): Bookmark => ({ id, label: id, tab, anchor, createdAt: 1 });

describe('bookmarkLabel', () => {
  it('collapses whitespace and clamps to 80 chars with an ellipsis', () => {
    expect(bookmarkLabel('  hello\n\n  world ')).toBe('hello world');
    const long = bookmarkLabel('a'.repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
    expect(bookmarkLabel('   ')).toBe('(empty message)');
  });
});

describe('toggleBookmark', () => {
  it('appends when the (tab, anchor) is new and reports added', () => {
    const r = toggleBookmark([mk('a')], mk('b'));
    expect(r.added).toBe(true);
    expect(r.bookmarks.map((b) => b.id)).toEqual(['a', 'b']);
  });

  it('removes the existing bookmark at the same (tab, anchor) regardless of id', () => {
    const r = toggleBookmark([mk('a'), mk('b')], { ...mk('zzz'), anchor: 'u:a' });
    expect(r.added).toBe(false);
    expect(r.bookmarks.map((b) => b.id)).toEqual(['b']);
  });

  it('treats the same anchor in another session as a different bookmark', () => {
    const r = toggleBookmark([mk('a')], mk('x', d1, 'u:a'));
    expect(r.added).toBe(true);
    expect(r.bookmarks).toHaveLength(2);
  });
});

describe('removeBookmark / findBookmark / bookmarkedAnchorsFor', () => {
  it('removes by id and returns the same array when nothing matches', () => {
    const list = [mk('a'), mk('b')];
    expect(removeBookmark(list, 'a').map((b) => b.id)).toEqual(['b']);
    expect(removeBookmark(list, 'nope')).toBe(list);
  });

  it('finds by (tab, anchor) and collects anchors per session', () => {
    const list = [mk('a'), mk('b', d1, 'n:1'), mk('c')];
    expect(findBookmark(list, s1, 'u:c')?.id).toBe('c');
    expect(findBookmark(list, d1, 'u:c')).toBeUndefined();
    expect([...bookmarkedAnchorsFor(list, s1)]).toEqual(['u:a', 'u:c']);
    expect([...bookmarkedAnchorsFor(list, d1)]).toEqual(['n:1']);
  });
});
