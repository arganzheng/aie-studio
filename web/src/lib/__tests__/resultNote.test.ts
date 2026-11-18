import { describe, expect, it } from 'vitest';
import { resultNote } from '../resultNote';

describe('resultNote', () => {
  it('says why a session stopped at its budget, with the amount', () => {
    expect(resultNote({ type: 'result', subtype: 'error_max_budget_usd', errors: ['Reached maximum budget ($0.5)'] }))
      .toBe('Stopped: this session reached the budget its parent session set ($0.5). Send a message to lift the limit and continue.');
  });
  it('works without an amount', () => {
    expect(resultNote({ type: 'result', subtype: 'error_max_budget_usd' })).toContain('reached the budget its parent session set.');
  });
  it('is silent for every other result', () => {
    expect(resultNote({ type: 'result', subtype: 'success' })).toBeNull();
    expect(resultNote({ type: 'result', subtype: 'error_max_turns' })).toBeNull();
    expect(resultNote({ type: 'assistant' })).toBeNull();
    expect(resultNote(null)).toBeNull();
  });
});
