import { describe, expect, it } from 'vitest';
import { withArrivedDuring } from '../refetchMerge';

describe('withArrivedDuring', () => {
  const fetched: { id: string; uuid?: string }[] = [{ id: 'f1', uuid: 'u1' }, { id: 'f2', uuid: 'u2' }];
  it('drops what was shown before the fetch, keeps what came in during it', () => {
    const current = [{ id: 'old', uuid: 'u0' }, { id: 'q', uuid: 'u9' }];
    expect(withArrivedDuring(fetched, current, new Set(['old']))).toEqual([...fetched, { id: 'q', uuid: 'u9' }]);
  });
  it('does not repeat one the fetch already has', () => {
    const current = [{ id: 'q', uuid: 'u2' }];
    expect(withArrivedDuring(fetched, current, new Set())).toBe(fetched);
  });
  it('keeps one without a uuid yet (still streaming)', () => {
    expect(withArrivedDuring(fetched, [{ id: 's' }], new Set())).toEqual([...fetched, { id: 's' }]);
  });
});
