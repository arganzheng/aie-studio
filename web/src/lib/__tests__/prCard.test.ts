import { describe, expect, it } from 'vitest';
import { checkCounts } from '../../components/PrCard';
import type { PrInfo } from '../../api';

describe('checkCounts', () => {
  it('counts checks by outcome', () => {
    const pr = { checks: [{ state: 'pass' }, { state: 'fail' }, { state: 'pass' }, { state: 'pending' }] } as unknown as PrInfo;
    expect(checkCounts(pr)).toEqual({ pass: 2, fail: 1, pending: 1, skipped: 0 });
  });
});
