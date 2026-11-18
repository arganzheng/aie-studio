import { describe, expect, it } from 'vitest';
import { markLocallyRead, removeLocally, shortAge, viewedUnread, type InboxItem, type InboxState } from '../inbox';

function item(id: string, over: Partial<InboxItem> = {}): InboxItem {
  return { id, kind: 'done', tabType: 'claude-sdk', projectId: 'p', sessionId: id, title: null, summary: null, at: 1, readAt: null, ...over };
}
const state = (items: InboxItem[]): InboxState => ({ items, unread: items.filter((i) => i.readAt === null).length, hasMore: false });

describe('markLocallyRead', () => {
  it('marks given ids and lowers the count', () => {
    const s = markLocallyRead(state([item('a'), item('b'), item('c', { readAt: 5 })]), new Set(['a', 'c']), 9);
    expect(s.items.map((i) => i.readAt)).toEqual([9, null, 5]);
    expect(s.unread).toBe(1);
  });
  it('all → zero unread; no-op returns the same object', () => {
    const s0 = state([item('a'), item('b')]);
    expect(markLocallyRead(s0, 'all', 9).unread).toBe(0);
    const read = state([item('a', { readAt: 1 })]);
    expect(markLocallyRead(read, 'all', 9)).toBe(read);
  });
});

describe('removeLocally', () => {
  it('drops the row and its unread count', () => {
    const s = removeLocally(state([item('a'), item('b', { readAt: 1 })]), 'a');
    expect(s.items.map((i) => i.id)).toEqual(['b']);
    expect(s.unread).toBe(0);
    expect(removeLocally(s, 'b').unread).toBe(0);
  });
});

describe('viewedUnread', () => {
  const tab = { id: 't', type: 'claude-sdk', resumeId: 'a' };
  it('only the unread row of the session on screen, when attending', () => {
    const items = [item('a'), item('b'), item('a2', { sessionId: 'a', readAt: 3 })];
    expect(viewedUnread(items, { attending: true, activeProjectId: 'p', activeTab: tab }).map((i) => i.id)).toEqual(['a']);
    expect(viewedUnread(items, { attending: false, activeProjectId: 'p', activeTab: tab })).toEqual([]);
    expect(viewedUnread(items, { attending: true, activeProjectId: 'q', activeTab: tab })).toEqual([]);
  });
});

describe('shortAge', () => {
  const now = 1_000_000_000;
  it('formats like Devin', () => {
    expect(shortAge(now - 10_000, now)).toBe('now');
    expect(shortAge(now - 5 * 60_000, now)).toBe('5m');
    expect(shortAge(now - 17 * 3600_000, now)).toBe('17h');
    expect(shortAge(now - 21 * 86400_000, now)).toBe('21d');
  });
});
