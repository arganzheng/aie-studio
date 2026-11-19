import { describe, expect, it } from 'vitest';
import { MODES, isSessionMode, modeInfo } from '../sessionMode';

describe('session mode', () => {
  it('offers bypass (first, the default) and plan', () => {
    expect(MODES.map((m) => m.id)).toEqual(['bypassPermissions', 'plan']);
    expect(modeInfo('plan').label).toBe('Plan');
  });
  it('rejects anything else', () => {
    expect(isSessionMode('plan')).toBe(true);
    expect(isSessionMode('auto')).toBe(false);
    expect(isSessionMode(null)).toBe(false);
  });
});
