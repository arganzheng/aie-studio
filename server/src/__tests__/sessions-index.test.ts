import { describe, expect, it } from 'vitest';
import { applySessionMeta, cleanTitle, descendantIds, forgetSession, MAX_TITLE_LENGTH, sessionKey, setArchived, type SessionRow } from '../sessions-index.js';
import { normalizeHeldReports, normalizeOwedReports, normalizeSessionMeta, setParent } from '../store.js';

function row(over: Partial<SessionRow> = {}): Omit<SessionRow, 'archived'> {
  return { kind: 'claude', sessionId: 's1', projectId: 'p1', title: 'First', updatedAt: 100, live: null, state: null, ...over };
}

describe('applySessionMeta', () => {
  it('sorts newest first and marks archived rows', () => {
    const rows = [row(), row({ sessionId: 's2', updatedAt: 300 }), row({ kind: 'devin', sessionId: 'd1', updatedAt: 200 })];
    const out = applySessionMeta(rows, { archived: ['devin:d1'], titles: {}, parents: {}, agentSpawned: [], groups: {}, status: {} });
    expect(out.map((r) => r.sessionId)).toEqual(['s2', 'd1', 's1']);
    expect(out.map((r) => r.archived)).toEqual([false, true, false]);
  });
  it('lets a stored title override the session\'s own, per kind', () => {
    const rows = [row({ kind: 'devin', sessionId: 'x', title: 'purrfect-opinion' }), row({ sessionId: 'x', title: 'Claude one' })];
    const out = applySessionMeta(rows, { archived: [], titles: { 'devin:x': 'Fix the build' }, parents: {}, agentSpawned: [], groups: {}, status: {} });
    expect(out.find((r) => r.kind === 'devin')!.title).toBe('Fix the build');
    expect(out.find((r) => r.kind === 'claude')!.title).toBe('Claude one');
  });
});

describe('session meta edits', () => {
  it('archives and unarchives without duplicates', () => {
    const key = sessionKey('claude', 's1');
    const a = setArchived({ archived: [], titles: {}, parents: {}, agentSpawned: [], groups: {}, status: {} }, key, true);
    expect(setArchived(a, key, true).archived).toEqual([key]);
    expect(setArchived(a, key, false).archived).toEqual([]);
  });
  it('forgets a deleted session', () => {
    const meta = { archived: ['claude:s1', 'devin:d1'], titles: { 'claude:s1': 'x', 'devin:d1': 'y' }, parents: {}, agentSpawned: [], groups: {}, status: {} };
    expect(forgetSession(meta, 'claude:s1')).toEqual({ archived: ['devin:d1'], titles: { 'devin:d1': 'y' }, parents: {}, agentSpawned: [], groups: {}, status: {} });
  });
  it('normalizes whatever is on disk', () => {
    expect(normalizeSessionMeta(null)).toEqual({ archived: [], titles: {}, parents: {}, agentSpawned: [], groups: {}, status: {} });
    expect(normalizeSessionMeta({ archived: ['a', 'a', 3], titles: { a: ' T ', b: '', c: 5 } })).toEqual({ archived: ['a'], titles: { a: 'T' }, parents: {}, agentSpawned: [], groups: {}, status: {} });
    // parents: strings only, and never a session under itself
    expect(normalizeSessionMeta({ parents: { 'claude:c1': 'p1', 'claude:x': 'x', 'claude:n': 7 } }).parents).toEqual({ 'claude:c1': 'p1' });
  });
});

describe('child sessions', () => {
  const empty = { archived: [], titles: {}, parents: {}, agentSpawned: [], groups: {}, status: {} };
  it('links a child to its parent and shows it on the row', () => {
    const meta = setParent(empty, 'claude:c1', 'p1');
    expect(meta.parents).toEqual({ 'claude:c1': 'p1' });
    const out = applySessionMeta([row({ sessionId: 'p1' }), row({ sessionId: 'c1' })], meta);
    expect(out.find((r) => r.sessionId === 'c1')!.parentId).toBe('p1');
    expect(out.find((r) => r.sessionId === 'p1')!.parentId).toBeUndefined();
  });
  it('refuses a link that would make a session its own ancestor', () => {
    const meta = setParent(setParent(empty, 'claude:b', 'a'), 'claude:c', 'b');
    expect(setParent(meta, 'claude:a', 'c')).toBe(meta);
    expect(setParent(meta, 'claude:a', 'a')).toBe(meta);
  });
  it('deleting a parent leaves its children as top-level sessions; deleting a child drops its link', () => {
    const meta = setParent(setParent(empty, 'claude:c1', 'p1'), 'claude:c2', 'p1');
    expect(forgetSession(meta, 'claude:c1').parents).toEqual({ 'claude:c2': 'p1' });
    expect(forgetSession(meta, 'claude:p1').parents).toEqual({});
  });
  it('remembers which children the agent opened, only while they stay linked', () => {
    const meta = { ...setParent(setParent(empty, 'claude:c1', 'p1'), 'claude:c2', 'p1'), agentSpawned: ['claude:c1'] };
    expect(normalizeSessionMeta(meta).agentSpawned).toEqual(['claude:c1']);
    expect(normalizeSessionMeta({ ...meta, agentSpawned: ['claude:c1', 'claude:gone', 'claude:c1', 4] }).agentSpawned).toEqual(['claude:c1']);
    expect(forgetSession(meta, 'claude:c2').agentSpawned).toEqual(['claude:c1']);
    expect(forgetSession(meta, 'claude:c1').agentSpawned).toEqual([]);
    expect(forgetSession(meta, 'claude:p1').agentSpawned).toEqual([]);
  });
});

describe('stopping a session with its children', () => {
  it('finds every descendant, nearest first, of the same kind only', () => {
    const parents = { 'claude:c1': 'p', 'claude:c2': 'p', 'claude:g1': 'c1', 'claude:other': 'q', 'devin:d1': 'p' };
    expect(descendantIds(parents, 'claude', 'p')).toEqual(['c1', 'c2', 'g1']);
    expect(descendantIds(parents, 'claude', 'c2')).toEqual([]);
    expect(descendantIds({ 'claude:a': 'b', 'claude:b': 'a' }, 'claude', 'a')).toEqual(['b']);
  });
});

describe('child groups', () => {
  const empty = { archived: [], titles: {}, parents: {}, agentSpawned: [], groups: {}, status: {} };
  it('shows the batch label on a child row, and only while it is linked', () => {
    const meta = { ...setParent(empty, 'claude:c1', 'p1'), groups: { 'claude:c1': 'Series review', 'claude:lost': 'x' } };
    expect(normalizeSessionMeta(meta).groups).toEqual({ 'claude:c1': 'Series review' });
    const out = applySessionMeta([row({ sessionId: 'p1' }), row({ sessionId: 'c1' })], normalizeSessionMeta(meta));
    expect(out.find((r) => r.sessionId === 'c1')!.group).toBe('Series review');
    expect(out.find((r) => r.sessionId === 'p1')!.group).toBeUndefined();
    expect(forgetSession(normalizeSessionMeta(meta), 'claude:p1').groups).toEqual({});
  });
});

describe('held reports', () => {
  it('keeps well-formed holds', () => {
    expect(normalizeHeldReports({ p1: { projectId: 'proj', cwd: '/w', reports: ['a', 2, 'b'] }, bad: { reports: [] }, n: null }))
      .toEqual({ p1: { projectId: 'proj', cwd: '/w', reports: ['a', 'b'] } });
  });
});

describe('owed child reports', () => {
  it('keeps well-formed records and drops the rest', () => {
    const good = { parentId: 'p', projectId: 'proj', cwd: '/w', title: 'T', requested: true, notes: ['a', 3, 'b'] };
    expect(normalizeOwedReports({ c1: good, c2: { parentId: '' }, c3: 'x', c4: { parentId: 'p', projectId: 'proj', cwd: '/w' } })).toEqual({
      c1: { ...good, notes: ['a', 'b'] },
      c4: { parentId: 'p', projectId: 'proj', cwd: '/w', title: '', requested: false, notes: [] },
    });
    expect(normalizeOwedReports(null)).toEqual({});
  });
});

describe('cleanTitle', () => {
  it('collapses whitespace, trims and caps', () => {
    expect(cleanTitle('  Fix\n the   build ')).toBe('Fix the build');
    expect(cleanTitle('x'.repeat(MAX_TITLE_LENGTH + 50))).toHaveLength(MAX_TITLE_LENGTH);
  });
  it('rejects empty and non-string titles', () => {
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
  });
});

describe('normalizeSessionMeta previews', () => {
  it('keeps valid shown pages, newest first, and drops bad ones', () => {
    const m = normalizeSessionMeta({ previews: {
      'claude:a': { port: 5000, path: '/', at: 1 },
      'claude:b': { port: 6000, path: '/x', at: 2 },
      'claude:c': { port: 80, path: '/', at: 3 },
      'claude:d': { port: 7000, path: 'no-slash', at: 4 },
    } });
    expect(Object.keys(m.previews ?? {})).toEqual(['claude:b', 'claude:a']);
  });
  it('leaves previews out when there are none', () => {
    expect('previews' in normalizeSessionMeta({})).toBe(false);
  });
});
