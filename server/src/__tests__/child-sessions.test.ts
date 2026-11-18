import { describe, it, expect } from 'vitest';
import { childIdsOf, childReport, cleanChildTitle, MAX_CHILD_DEPTH, MAX_REPORT_CHARS, MAX_RUNNING_CHILDREN, parseChildReport, sessionDepth, spawnRefusal } from '../child-sessions.js';

const parents = { 'claude:c1': 'p', 'claude:c2': 'p', 'claude:g1': 'c1', 'devin:d': 'p' };

describe('child session tree', () => {
  it('measures depth along the parent links and survives a cycle', () => {
    expect(sessionDepth(parents, 'p')).toBe(0);
    expect(sessionDepth(parents, 'c1')).toBe(1);
    expect(sessionDepth(parents, 'g1')).toBe(2);
    expect(sessionDepth({ 'claude:a': 'b', 'claude:b': 'a' }, 'a')).toBe(1);
  });
  it('lists the Claude children of a session', () => {
    expect(childIdsOf(parents, 'p').sort()).toEqual(['c1', 'c2']);
    expect(childIdsOf(parents, 'c2')).toEqual([]);
  });
});

describe('spawnRefusal', () => {
  it('allows a spawn within the limits', () => {
    expect(spawnRefusal({ depth: 0, runningChildren: 0 })).toBeNull();
    expect(spawnRefusal({ depth: MAX_CHILD_DEPTH - 1, runningChildren: MAX_RUNNING_CHILDREN - 1 })).toBeNull();
  });
  it('refuses past the nesting or concurrency limit, saying why', () => {
    expect(spawnRefusal({ depth: MAX_CHILD_DEPTH, runningChildren: 0 })).toMatch(/nested at most/);
    expect(spawnRefusal({ depth: 0, runningChildren: MAX_RUNNING_CHILDREN })).toMatch(/still working/);
  });
});

describe('child reports', () => {
  it('round-trips through the parser', () => {
    const text = childReport({ title: 'Draft tests', sessionId: 'abc-123', ok: true, result: 'Wrote 3 tests.\n\nAll pass.' });
    expect(text.startsWith('[Child session "Draft tests" (abc-123) finished]')).toBe(true);
    expect(parseChildReport(text)).toEqual({ title: 'Draft tests', sessionId: 'abc-123', ok: true, body: 'Wrote 3 tests.\n\nAll pass.' });
  });
  it('marks errors and empty answers', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: false, result: '', errorKind: 'error_max_turns' });
    expect(text).toContain('stopped with an error (error_max_turns)]');
    expect(parseChildReport(text)).toMatchObject({ ok: false, body: '(the child session gave no final answer)' });
  });
  it('cuts a very long answer and says so', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: true, result: 'x'.repeat(MAX_REPORT_CHARS + 500) });
    expect(text).toContain('report cut at');
    expect(text.length).toBeLessThan(MAX_REPORT_CHARS + 400);
  });
  it('ignores ordinary messages', () => {
    expect(parseChildReport('hello')).toBeNull();
    expect(parseChildReport('[Child session of mine] is slow')).toBeNull();
  });
  it('tidies titles', () => {
    expect(cleanChildTitle('  Draft\n tests  ')).toBe('Draft tests');
    expect(cleanChildTitle('   ')).toBe('Child session');
    expect(cleanChildTitle('x'.repeat(200))).toHaveLength(80);
  });
});
