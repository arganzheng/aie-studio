import { describe, expect, it } from 'vitest';
import { diffQuoteSource, statusLetter } from '../diffQuote';

describe('diffQuoteSource', () => {
  it('spans the new line numbers of the selected rows', () => {
    expect(diffQuoteSource([{ path: 'a.ts', oldNo: 4, newNo: 4 }, { path: 'a.ts', oldNo: 5 }, { path: 'a.ts', newNo: 5 }, { path: 'a.ts', newNo: 6 }]))
      .toEqual({ path: 'a.ts', lines: [4, 6] });
  });
  it('uses the old numbers when only removed lines are selected', () => {
    expect(diffQuoteSource([{ path: 'a.ts', oldNo: 9 }, { path: 'a.ts', oldNo: 10 }])).toEqual({ path: 'a.ts (before the change)', lines: [9, 10] });
  });
  it('gives no range across files, and nothing for no rows', () => {
    expect(diffQuoteSource([{ path: 'a.ts', newNo: 1 }, { path: 'b.ts', newNo: 1 }])).toEqual({ path: 'a.ts', lines: null });
    expect(diffQuoteSource([])).toBeNull();
  });
});

describe('statusLetter', () => {
  it('matches git status --short', () => {
    expect(['added', 'deleted', 'renamed', 'untracked', 'modified'].map(statusLetter).join('')).toBe('ADRUM');
  });
});
