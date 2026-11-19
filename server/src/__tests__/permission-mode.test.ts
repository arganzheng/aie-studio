import { describe, expect, it } from 'vitest';
import { isSessionMode, planOf, planRejection } from '../permission-mode.js';
import { normalizeChildTerms } from '../store.js';

describe('session mode', () => {
  it('knows the two modes', () => {
    expect(isSessionMode('plan')).toBe(true);
    expect(isSessionMode('bypassPermissions')).toBe(true);
    expect(isSessionMode('acceptEdits')).toBe(false);
    expect(isSessionMode(undefined)).toBe(false);
  });
  it('reads the plan of an ExitPlanMode call', () => {
    expect(planOf({ plan: '  # Do it\n' })).toBe('# Do it');
    expect(planOf({})).toBe('');
    expect(planOf(null)).toBe('');
  });
  it('words a rejection with and without feedback', () => {
    expect(planRejection(' also add tests ')).toContain('asks for changes:\n\nalso add tests\n\n');
    expect(planRejection('')).toContain('wait for their next message');
    expect(planRejection(undefined)).toContain('wait for their next message');
  });
  it('is kept with the session terms only when it is not the default', () => {
    expect(normalizeChildTerms({ a: { mode: 'plan' }, b: { mode: 'bypassPermissions' }, c: { mode: 'x' } })).toEqual({ a: { mode: 'plan' } });
    expect(normalizeChildTerms({ a: { mode: 'plan', resultSchema: { type: 'object' } } })).toEqual({ a: { mode: 'plan', resultSchema: { type: 'object' } } });
  });
});
