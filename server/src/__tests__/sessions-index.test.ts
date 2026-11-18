import { describe, expect, it } from 'vitest';
import { applySessionMeta, cleanTitle, forgetSession, MAX_TITLE_LENGTH, sessionKey, setArchived, type SessionRow } from '../sessions-index.js';
import { normalizeSessionMeta, setParent } from '../store.js';

function row(over: Partial<SessionRow> = {}): Omit<SessionRow, 'archived'> {
  return { kind: 'claude', sessionId: 's1', projectId: 'p1', title: 'First', updatedAt: 100, live: null, state: null, ...over };
}

describe('applySessionMeta', () => {
  it('sorts newest first and marks archived rows', () => {
    const rows = [row(), row({ sessionId: 's2', updatedAt: 300 }), row({ kind: 'devin', sessionId: 'd1', updatedAt: 200 })];
    const out = applySessionMeta(rows, { archived: ['devin:d1'], titles: {}, parents: {}, agentSpawned: [] });
    expect(out.map((r) => r.sessionId)).toEqual(['s2', 'd1', 's1']);
    expect(out.map((r) => r.archived)).toEqual([false, true, false]);
  });
  it('lets a stored title override the session\'s own, per kind', () => {
    const rows = [row({ kind: 'devin', sessionId: 'x', title: 'purrfect-opinion' }), row({ sessionId: 'x', title: 'Claude one' })];
    const out = applySessionMeta(rows, { archived: [], titles: { 'devin:x': 'Fix the build' }, parents: {}, agentSpawned: [] });
    expect(out.find((r) => r.kind === 'devin')!.title).toBe('Fix the build');
    expect(out.find((r) => r.kind === 'claude')!.title).toBe('Claude one');
  });
});

describe('session meta edits', () => {
  it('archives and unarchives without duplicates', () => {
    const key = sessionKey('claude', 's1');
    const a = setArchived({ archived: [], titles: {}, parents: {}, agentSpawned: [] }, key, true);
    expect(setArchived(a, key, true).archived).toEqual([key]);
    expect(setArchived(a, key, false).archived).toEqual([]);
  });
  it('forgets a deleted session', () => {
    const meta = { archived: ['claude:s1', 'devin:d1'], titles: { 'claude:s1': 'x', 'devin:d1': 'y' }, parents: {}, agentSpawned: [] };
    expect(forgetSession(meta, 'claude:s1')).toEqual({ archived: ['devin:d1'], titles: { 'devin:d1': 'y' }, parents: {}, agentSpawned: [] });
  });
  it('normalizes whatever is on disk', () => {
    expect(normalizeSessionMeta(null)).toEqual({ archived: [], titles: {}, parents: {}, agentSpawned: [] });
    expect(normalizeSessionMeta({ archived: ['a', 'a', 3], titles: { a: ' T ', b: '', c: 5 } })).toEqual({ archived: ['a'], titles: { a: 'T' }, parents: {}, agentSpawned: [] });
    // parents: strings only, and never a session under itself
    expect(normalizeSessionMeta({ parents: { 'claude:c1': 'p1', 'claude:x': 'x', 'claude:n': 7 } }).parents).toEqual({ 'claude:c1': 'p1' });
  });
});

describe('child sessions', () => {
  const empty = { archived: [], titles: {}, parents: {}, agentSpawned: [] };
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
