import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxStore, KEEP_MAX, KEEP_MS, SUMMARY_MAX, askSummary, sessionKey, toSummary } from '../inbox.js';
import type { SessionEvent } from '../notify.js';

let n = 0;
function ev(over: Partial<SessionEvent> = {}): SessionEvent {
  n++;
  return { id: `e${n}`, kind: 'done', tabType: 'claude-sdk', projectId: 'p', sessionId: `s${n}`, title: `T${n}`, summary: null, at: 1000 + n, ...over };
}

describe('toSummary', () => {
  it('flattens markdown to one line', () => {
    expect(toSummary('## Done\n\n- fixed **bug** in `a.ts`\n- see [PR](http://x)')).toBe('Done fixed bug in a.ts see PR');
  });
  it('drops code blocks and cuts long text', () => {
    expect(toSummary('ok\n```\ncode\n```\nbye')).toBe('ok bye');
    const s = toSummary('x'.repeat(500))!;
    expect(s).toHaveLength(SUMMARY_MAX);
    expect(s.endsWith('…')).toBe(true);
  });
  it('null for nothing', () => {
    expect(toSummary(undefined)).toBeNull();
    expect(toSummary('  \n ')).toBeNull();
  });
  it('askSummary takes the first question', () => {
    expect(askSummary({ questions: [{ question: 'Which DB?' }, { question: 'b' }] })).toBe('Which DB?');
    expect(askSummary(null)).toBeNull();
  });
});

describe('sessionKey', () => {
  it('treats both Claude tab kinds as one family', () => {
    const a = ev({ tabType: 'session', sessionId: 'x' });
    const b = ev({ tabType: 'claude-sdk', sessionId: 'x' });
    const d = ev({ tabType: 'devin', sessionId: 'x' });
    expect(sessionKey(a)).toBe(sessionKey(b));
    expect(sessionKey(d)).not.toBe(sessionKey(a));
  });
});

describe('InboxStore', () => {
  let store: InboxStore;
  beforeEach(() => { store = new InboxStore(':memory:'); });
  afterEach(() => store.close());

  it('lists newest first and counts unread', () => {
    store.add('u', ev({ at: 10 }));
    store.add('u', ev({ at: 30 }));
    store.add('u', ev({ at: 20 }));
    store.add('other', ev({ at: 40 }));
    expect(store.list('u').map((i) => i.at)).toEqual([30, 20, 10]);
    expect(store.unreadCount('u')).toBe(3);
  });

  it('keeps one row per session; a newer event makes it unread again', () => {
    const first = ev({ sessionId: 'x', at: 10, summary: 'first', title: 'Title' });
    store.add('u', first);
    store.markRead('u', { ids: [first.id] }, 11);
    expect(store.unreadCount('u')).toBe(0);
    store.add('u', ev({ sessionId: 'x', kind: 'awaiting', at: 12, title: null, summary: null }));
    const items = store.list('u');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'awaiting', at: 12, readAt: null, title: 'Title', summary: 'first' });
  });

  it('marks read by id, by session and all', () => {
    const a = ev(); const b = ev({ tabType: 'session', sessionId: 'y' }); const c = ev();
    for (const e of [a, b, c]) store.add('u', e);
    expect(store.markRead('u', { ids: [a.id] }, 1)).toBe(1);
    expect(store.markRead('u', { sessions: [sessionKey({ ...b, tabType: 'claude-sdk' })] }, 1)).toBe(1);
    expect(store.list('u', { unreadOnly: true }).map((i) => i.id)).toEqual([c.id]);
    expect(store.markRead('u', { all: true }, 1)).toBe(1);
    expect(store.unreadCount('u')).toBe(0);
  });

  it('pages with before/limit', () => {
    for (let i = 1; i <= 5; i++) store.add('u', ev({ at: i * 10 }));
    expect(store.list('u', { limit: 2 }).map((i) => i.at)).toEqual([50, 40]);
    expect(store.list('u', { before: 40, limit: 2 }).map((i) => i.at)).toEqual([30, 20]);
  });

  it('prunes old and excess rows', () => {
    store.add('u', ev({ at: 0 }));
    store.add('u', ev({ at: KEEP_MS + 10 }));
    expect(store.list('u').map((i) => i.at)).toEqual([KEEP_MS + 10]);
    for (let i = 0; i < KEEP_MAX + 3; i++) store.add('u', ev({ at: KEEP_MS + 100 + i }));
    expect(store.list('u', { limit: 200 })).toHaveLength(200);
    expect(store.unreadCount('u')).toBe(KEEP_MAX);
  });

  it('removes and clears', () => {
    const a = ev(); store.add('u', a); store.add('u', ev()); store.add('v', ev());
    expect(store.remove('u', [a.id])).toBe(1);
    expect(store.clear('u')).toBe(1);
    expect(store.unreadCount('v')).toBe(1);
  });
});
