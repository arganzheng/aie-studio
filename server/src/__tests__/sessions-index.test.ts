import { describe, expect, it } from 'vitest';
import { applySessionMeta, cleanTitle, forgetSession, MAX_TITLE_LENGTH, sessionKey, setArchived, type SessionRow } from '../sessions-index.js';
import { normalizeSessionMeta } from '../store.js';

function row(over: Partial<SessionRow> = {}): Omit<SessionRow, 'archived'> {
  return { kind: 'claude', sessionId: 's1', projectId: 'p1', title: 'First', updatedAt: 100, live: null, state: null, ...over };
}

describe('applySessionMeta', () => {
  it('sorts newest first and marks archived rows', () => {
    const rows = [row(), row({ sessionId: 's2', updatedAt: 300 }), row({ kind: 'devin', sessionId: 'd1', updatedAt: 200 })];
    const out = applySessionMeta(rows, { archived: ['devin:d1'], titles: {} });
    expect(out.map((r) => r.sessionId)).toEqual(['s2', 'd1', 's1']);
    expect(out.map((r) => r.archived)).toEqual([false, true, false]);
  });
  it('lets a stored title override the session\'s own, per kind', () => {
    const rows = [row({ kind: 'devin', sessionId: 'x', title: 'purrfect-opinion' }), row({ sessionId: 'x', title: 'Claude one' })];
    const out = applySessionMeta(rows, { archived: [], titles: { 'devin:x': 'Fix the build' } });
    expect(out.find((r) => r.kind === 'devin')!.title).toBe('Fix the build');
    expect(out.find((r) => r.kind === 'claude')!.title).toBe('Claude one');
  });
});

describe('session meta edits', () => {
  it('archives and unarchives without duplicates', () => {
    const key = sessionKey('claude', 's1');
    const a = setArchived({ archived: [], titles: {} }, key, true);
    expect(setArchived(a, key, true).archived).toEqual([key]);
    expect(setArchived(a, key, false).archived).toEqual([]);
  });
  it('forgets a deleted session', () => {
    const meta = { archived: ['claude:s1', 'devin:d1'], titles: { 'claude:s1': 'x', 'devin:d1': 'y' } };
    expect(forgetSession(meta, 'claude:s1')).toEqual({ archived: ['devin:d1'], titles: { 'devin:d1': 'y' } });
  });
  it('normalizes whatever is on disk', () => {
    expect(normalizeSessionMeta(null)).toEqual({ archived: [], titles: {} });
    expect(normalizeSessionMeta({ archived: ['a', 'a', 3], titles: { a: ' T ', b: '', c: 5 } })).toEqual({ archived: ['a'], titles: { a: 'T' } });
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
