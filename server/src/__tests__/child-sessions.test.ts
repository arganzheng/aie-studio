import { normalizeChildTerms } from '../store.js';
import { describe, it, expect } from 'vitest';
import { lastModelOf, childIdsOf, childReport, cleanBudget, cleanResultSchema, usd, cleanChildTitle, cleanGroup, joinReports, splitReports, isTurnResult, MAX_CHILD_DEPTH, MAX_NOTE_CHARS, MAX_REPORT_CHARS, MAX_RUNNING_CHILDREN, parseChildReport, sessionDepth, spawnRefusal } from '../child-sessions.js';

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

describe('isTurnResult', () => {
  it('skips the empty bookkeeping result a resumed session can start with', () => {
    expect(isTurnResult({ type: 'result', subtype: 'success', num_turns: 0, result: '' })).toBe(false);
    expect(isTurnResult({ type: 'result', subtype: 'success', num_turns: 0 })).toBe(false);
  });
  it('keeps real turns, including failed and textless ones', () => {
    expect(isTurnResult({ subtype: 'success', num_turns: 1, result: 'done' })).toBe(true);
    expect(isTurnResult({ subtype: 'error_during_execution', num_turns: 2 })).toBe(true);
    expect(isTurnResult({ subtype: 'success', num_turns: 0, result: 'text' })).toBe(true);
    expect(isTurnResult({ subtype: 'success' })).toBe(true);
  });
});

describe('reports delivered together', () => {
  it('joins reports so each can be told apart again', () => {
    const a = childReport({ title: 'A', sessionId: 's1', ok: true, result: 'First.\n\nTwo paragraphs.' });
    const b = childReport({ title: 'B', sessionId: 's2', ok: false, result: '', stopped: 'user' });
    const c = childReport({ title: 'C', sessionId: 's3', ok: true, result: 'Third.', userNotes: ['Skip X.'] });
    const joined = joinReports([a, b, c]);
    const parts = splitReports(joined);
    expect(parts).toEqual([a, b, c]);
    expect(parts.map((p) => parseChildReport(p)!.title)).toEqual(['A', 'B', 'C']);
  });
  it('leaves a single report whole', () => {
    const a = childReport({ title: 'A', sessionId: 's1', ok: true, result: 'Only one.' });
    expect(splitReports(a)).toEqual([a]);
  });
  it('tidies group labels', () => {
    expect(cleanGroup('  Python   series\nreview ')).toBe('Python series review');
    expect(cleanGroup(undefined)).toBe('');
    expect(cleanGroup('x'.repeat(200))).toHaveLength(60);
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
  it('quotes what the user told the child ahead of its answer', () => {
    const text = childReport({ title: 'Draft tests', sessionId: 'abc-123', ok: true, result: 'Dropped the UI tests.', userNotes: ['Skip the UI tests.\nUnit tests only.', '  ', 'Use vitest.'] });
    expect(text.startsWith('[Child session "Draft tests" (abc-123) finished after the user stepped in]')).toBe(true);
    expect(text).toContain('The user spoke to this child session directly:\n\n> Skip the UI tests.\n> Unit tests only.\n>\n> Use vitest.');
    expect(text).toContain('The child session then answered:\n\nDropped the UI tests.');
    expect(text).toContain('If this changes your plan');
    const parsed = parseChildReport(text)!;
    expect(parsed).toMatchObject({ title: 'Draft tests', sessionId: 'abc-123', ok: true });
    expect(parsed.body).toContain('> Use vitest.');
    expect(parsed.body).not.toContain('Sent automatically');
  });
  it('cuts a very long intervention', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: true, result: 'ok', userNotes: ['y'.repeat(MAX_NOTE_CHARS + 100)] });
    expect(text).toContain('… [cut]');
    expect(text.length).toBeLessThan(MAX_NOTE_CHARS + 600);
  });
  it('says who stopped a child, and keeps what the user had told it', () => {
    const byUser = childReport({ title: 'T', sessionId: 's1', ok: false, result: '', stopped: 'user' });
    expect(byUser).toContain('[Child session "T" (s1) was stopped by the user]');
    expect(byUser).toContain('use send_to_child_session to have it continue');
    expect(parseChildReport(byUser)).toMatchObject({ ok: false });
    const byParent = childReport({ title: 'T', sessionId: 's1', ok: false, result: 'Got half way.', stopped: 'parent' });
    expect(byParent).toContain('was stopped by its parent session]\n\nGot half way.');
    const restart = childReport({ title: 'T', sessionId: 's1', ok: false, result: '', stopped: 'restart', userNotes: ['Unit tests only.'] });
    expect(restart).toContain('was interrupted by an aie-studio restart]');
    expect(restart).toContain('> Unit tests only.');
    expect(parseChildReport(restart)).toMatchObject({ title: 'T', sessionId: 's1', ok: false });
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

describe('budget and structured results', () => {
  it('reports a child that used up its budget, with how to let it go on', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: false, result: '', errorKind: 'error_max_budget_usd', budgetUsd: 0.5 });
    expect(text).toContain('stopped with an error (its budget of $0.5 is used up)]');
    expect(text).toContain('add_budget_usd');
    expect(parseChildReport(text)).toMatchObject({ ok: false, sessionId: 's1' });
  });
  it('carries a structured result as JSON in place of the prose', () => {
    const text = childReport({ title: 'T', sessionId: 's1', ok: true, result: '{"verdict":"fail"}', structured: { verdict: 'fail', issues: ['a'] } });
    expect(text).toContain('Structured result (matches the schema you gave):');
    expect(text).toContain('```json\n{\n  "verdict": "fail",');
    expect(parseChildReport(text)?.ok).toBe(true);
  });
  it('keeps the prose when there is no structured result, or the turn failed', () => {
    expect(childReport({ title: 'T', sessionId: 's1', ok: true, result: 'done' })).not.toContain('Structured result');
    expect(childReport({ title: 'T', sessionId: 's1', ok: false, result: '', errorKind: 'x', structured: { a: 1 } })).not.toContain('Structured result');
  });
  it('cleans a budget', () => {
    expect(cleanBudget(2)).toBe(2);
    expect(cleanBudget('0.25')).toBe(0.25);
    expect(cleanBudget(0)).toBeNull();
    expect(cleanBudget(-1)).toBeNull();
    expect(cleanBudget('abc')).toBeNull();
    expect(usd(2)).toBe('$2.00');
    expect(usd(0.5)).toBe('$0.5');
  });
  it('accepts only an object schema of a sane size', () => {
    expect(cleanResultSchema(undefined, 100)).toBeNull();
    expect(cleanResultSchema({ type: 'object', properties: {} }, 100)).toEqual({ schema: { type: 'object', properties: {} } });
    expect(cleanResultSchema('{"type":"object"}', 100)).toEqual({ schema: { type: 'object' } });
    expect(cleanResultSchema({ type: 'array' }, 100)).toHaveProperty('error');
    expect(cleanResultSchema('{nope', 100)).toHaveProperty('error');
    expect(cleanResultSchema({ type: 'object', description: 'x'.repeat(200) }, 100)).toHaveProperty('error');
  });
  it('normalizes stored terms', () => {
    expect(normalizeChildTerms({ a: { budgetUsd: 1 }, b: { budgetUsd: -1 }, c: { resultSchema: { type: 'object' } }, d: 3, e: {} }))
      .toEqual({ a: { budgetUsd: 1 }, c: { resultSchema: { type: 'object' } } });
  });
});

describe('lastModelOf', () => {
  it('finds the model of the last real answer', () => {
    expect(lastModelOf([
      { type: 'user', message: {} },
      { type: 'assistant', message: { model: 'claude-a' } },
      { type: 'assistant', message: { model: 'claude-b' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'user', message: {} },
    ])).toBe('claude-b');
  });
  it('is null for a session that never answered', () => {
    expect(lastModelOf([])).toBeNull();
    expect(lastModelOf([{ type: 'user', message: {} }, null])).toBeNull();
  });
});
