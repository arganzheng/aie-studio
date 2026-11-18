import { describe, expect, it } from 'vitest';
import { NO_FILTER, childSessions, groupChildren, filterSessions, isFiltering, sectionSessions, sessionRowKey, sessionStatus, timeAgo, type SessionRow } from '../sessionList';
import { alertKey } from '../sessionAlerts';

function row(over: Partial<SessionRow> = {}): SessionRow {
  return { kind: 'claude', sessionId: 's1', projectId: 'p1', title: 'Fix rounding', updatedAt: 1000, live: null, state: null, archived: false, ...over };
}
const none = new Set<string>();

describe('filterSessions', () => {
  const rows = [
    row(),
    row({ sessionId: 's2', title: 'Landing page copy', state: 'running', live: 'sdk' }),
    row({ kind: 'devin', sessionId: 'purrfect-opinion', title: 'Review comments' }),
    row({ sessionId: 's3', title: 'Old experiment', archived: true }),
  ];
  it('hides archived sessions unless asked for them', () => {
    expect(filterSessions(rows, NO_FILTER, none).map((r) => r.sessionId)).toEqual(['s1', 's2', 'purrfect-opinion']);
    expect(filterSessions(rows, { ...NO_FILTER, archived: true }, none).map((r) => r.sessionId)).toEqual(['s3']);
  });
  it('filters by kind', () => {
    expect(filterSessions(rows, { ...NO_FILTER, kind: 'devin' }, none)).toHaveLength(1);
  });
  it('"active" keeps running, waiting and unread sessions', () => {
    expect(filterSessions(rows, { ...NO_FILTER, status: 'active' }, none).map((r) => r.sessionId)).toEqual(['s2']);
    const unread = new Set([sessionRowKey(rows[0])]);
    expect(filterSessions(rows, { ...NO_FILTER, status: 'active' }, unread).map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });
  it('searches titles (any case) and session id prefixes', () => {
    expect(filterSessions(rows, { ...NO_FILTER, query: 'LANDING' }, none).map((r) => r.sessionId)).toEqual(['s2']);
    expect(filterSessions(rows, { ...NO_FILTER, query: 'purr' }, none).map((r) => r.sessionId)).toEqual(['purrfect-opinion']);
  });
  it('knows when a filter (not a search) is on', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering({ ...NO_FILTER, query: 'x' })).toBe(false);
    expect(isFiltering({ ...NO_FILTER, kind: 'claude' })).toBe(true);
  });
});

describe('sessionRowKey', () => {
  it('matches the key of an alert for the same session', () => {
    const ev = { id: 'e', kind: 'done' as const, projectId: 'p1', sessionId: 's1', title: null, at: 1 };
    expect(alertKey({ ...ev, tabType: 'claude-sdk' })).toBe(sessionRowKey(row()));
    expect(alertKey({ ...ev, tabType: 'session' })).toBe(sessionRowKey(row()));
    expect(alertKey({ ...ev, tabType: 'devin' })).toBe(sessionRowKey(row({ kind: 'devin' })));
  });
});

describe('sessionStatus', () => {
  const now = 1000 + 3 * 3600_000;
  it('ranks waiting over running over unread over idle', () => {
    expect(sessionStatus(row({ state: 'awaiting' }), true, now)).toEqual({ tone: 'awaiting', label: 'Needs your input' });
    expect(sessionStatus(row({ state: 'running' }), true, now)).toEqual({ tone: 'running', label: 'Running…' });
    expect(sessionStatus(row({ state: 'idle' }), true, now)).toEqual({ tone: 'unread', label: 'Finished · 3 hours ago' });
    expect(sessionStatus(row(), false, now)).toEqual({ tone: 'idle', label: '3 hours ago' });
  });
});

describe('timeAgo', () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const ago = (ms: number) => timeAgo(now - ms, now);
  it('words recent times', () => {
    expect(ago(20_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(3600_000)).toBe('1 hour ago');
    expect(ago(3 * 3600_000)).toBe('3 hours ago');
    expect(ago(30 * 3600_000)).toBe('yesterday');
    expect(ago(7 * 86400_000)).toBe('7 days ago');
    expect(ago(40 * 86400_000)).toBe('last month');
    expect(ago(100 * 86400_000)).toBe('3 months ago');
  });
  it('is empty for an unknown time and never negative', () => {
    expect(timeAgo(0, now)).toBe('');
    expect(timeAgo(now + 5000, now)).toBe('just now');
  });
});

describe('sectionSessions', () => {
  const rows = [
    row({ sessionId: 'a', title: 'Usage badge', state: 'running', live: 'sdk' }),
    row({ sessionId: 'b', title: 'PR review' }),
    row({ kind: 'devin', sessionId: 'd1', title: 'Docs' }),
    row({ sessionId: 'old', title: 'Dir picker' }),
  ];
  const groups = [{ id: 'g1', name: 'Feature X' }, { id: 'g2', name: 'Bugfix' }];
  const tabs = [
    { id: 't1', type: 'claude-sdk', resumeId: 'a', groupId: 'g1' },
    { id: 't2', type: 'file', groupId: 'g1' },
    { id: 't3', type: 'session', resumeId: 'b', groupId: 'g1' },
    { id: 't4', type: 'devin', resumeId: 'd1' },               // no groupId → default
    { id: 't5', type: 'claude-sdk', title: 'Fresh', groupId: 'gone' }, // dead Group → default
  ];
  const base = { projectId: 'p1', rows, allRows: rows, tabs, groups, defaultName: 'Default', filtering: false };

  it('puts open sessions under their Group in tab order and the rest in History', () => {
    const { sections, history } = sectionSessions(base);
    expect(sections.map((s) => [s.groupId, s.items.map((i) => i.tabId), s.tabCount, s.otherTabs])).toEqual([
      ['g1', ['t1', 't3'], 3, 1],
      ['g2', [], 0, 0],
      ['default', ['t4', 't5'], 2, 0],
    ]);
    expect(sections[2].isDefault).toBe(true);
    expect(sections[2].items[1]).toEqual({ tabId: 't5', kind: 'claude', row: null, title: 'Fresh' });
    expect(history.map((r) => r.sessionId)).toEqual(['old']);
  });

  it('omits the default Group while it has no tabs', () => {
    const { sections } = sectionSessions({ ...base, tabs: tabs.slice(0, 3) });
    expect(sections.map((s) => s.groupId)).toEqual(['g1', 'g2']);
  });

  it('while filtering, hides filtered-out tabs, unlisted tabs and empty sections', () => {
    const shown = filterSessions(rows, { ...NO_FILTER, query: 'review' }, none);
    const { sections, history } = sectionSessions({ ...base, rows: shown, filtering: true });
    expect(sections.map((s) => [s.groupId, s.items.map((i) => i.tabId)])).toEqual([['g1', ['t3']]]);
    expect(history).toEqual([]);
  });

  it('does not list an open session in History even when another kind of tab shows it', () => {
    const { history } = sectionSessions({ ...base, tabs: [{ id: 'x', type: 'session', resumeId: 'old' }] });
    expect(history.map((r) => r.sessionId)).toEqual(['a', 'b', 'd1']);
  });
});

describe('childSessions', () => {
  const rows = [
    row({ sessionId: 'p', title: 'Parent', updatedAt: 50 }),
    row({ sessionId: 'c2', title: 'Second child', parentId: 'p', updatedAt: 30 }),
    row({ sessionId: 'c1', title: 'First child', parentId: 'p', updatedAt: 20 }),
    row({ sessionId: 'orphan', title: 'Orphan', parentId: 'deleted' }),
    row({ kind: 'devin', sessionId: 'p', title: 'Devin with the same id' }),
    row({ sessionId: 'far', title: 'Other project child', projectId: 'p2', parentId: 'p' }),
  ];
  const tabs = [
    { id: 't1', type: 'claude-sdk', resumeId: 'c1' },
    { id: 't2', type: 'claude-sdk', title: 'Child of Parent', parentSessionId: 'p' }, // not started yet
    { id: 't3', type: 'claude-sdk', title: 'Lost', parentSessionId: 'nowhere' },
  ];
  const idx = childSessions({ projectId: 'p1', rows, tabs });

  it('files children under a listed parent, oldest first, unstarted tabs last', () => {
    expect([...idx.childrenOf.keys()]).toEqual(['p']);
    expect(idx.childrenOf.get('p')!.map((c) => [c.row?.sessionId ?? null, c.tabId, c.title])).toEqual([
      ['c1', 't1', 'First child'],
      ['c2', null, 'Second child'],
      [null, 't2', 'Child of Parent'],
    ]);
  });

  it('takes children out of the top level; orphans and other projects stay', () => {
    expect([...idx.childRowKeys].sort()).toEqual(['p1:claude:c1', 'p1:claude:c2']);
    expect([...idx.childTabIds].sort()).toEqual(['t1', 't2']);
  });
});

describe('groupChildren', () => {
  const item = (sessionId: string, over: Partial<SessionRow> = {}) => ({ row: row({ sessionId, ...over }), tabId: null, title: sessionId });
  it('nests a batch under its label where its first member stands, counting the running ones', () => {
    const nodes = groupChildren([
      item('a'),
      item('b', { group: 'Series review', state: 'running', live: 'sdk' }),
      item('c'),
      item('d', { group: 'Series review' }),
      { row: null, tabId: 't9', title: 'New child session' },
    ]);
    expect(nodes.map((n) => (n.kind === 'group' ? `${n.label}:${n.items.map((i) => i.row!.sessionId).join('+')}:${n.total - n.running}/${n.total}` : n.item.row?.sessionId ?? 'pending')))
      .toEqual(['a', 'Series review:b+d:1/2', 'c', 'pending']);
  });
  it('leaves children without a label as they are', () => {
    expect(groupChildren([item('a'), item('b')]).every((n) => n.kind === 'child')).toBe(true);
  });
});
