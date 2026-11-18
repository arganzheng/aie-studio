import { describe, expect, it } from 'vitest';
import { activityMark, sameActivity } from '../tabActivity';

describe('activityMark', () => {
  it('returns null for no activity', () => {
    expect(activityMark(undefined)).toBeNull();
    expect(activityMark({ generating: false, awaitingInput: false })).toBeNull();
  });
  it('awaiting outranks generating', () => {
    expect(activityMark({ generating: true, awaitingInput: true })).toBe('awaiting');
    expect(activityMark({ generating: true, awaitingInput: false })).toBe('generating');
    expect(activityMark({ generating: false, awaitingInput: true })).toBe('awaiting');
  });
});

describe('sameActivity', () => {
  it('compares both flags', () => {
    expect(sameActivity(undefined, { generating: true, awaitingInput: false })).toBe(false);
    expect(sameActivity({ generating: true, awaitingInput: false }, { generating: true, awaitingInput: false })).toBe(true);
    expect(sameActivity({ generating: true, awaitingInput: false }, { generating: true, awaitingInput: true })).toBe(false);
  });
});
