import { describe, expect, it } from 'vitest';
import { entryInHtml, isNewer } from '../appVersion';

describe('entryInHtml', () => {
  it('reads the entry script of a built index.html', () => {
    const html = '<head><script type="module" crossorigin src="/assets/index-DVSfm2cb.js"></script><link rel="stylesheet" href="/assets/index-rre6gnS_.css"></head>';
    expect(entryInHtml(html)).toBe('/assets/index-DVSfm2cb.js');
  });
  it('is null for the dev server page', () => {
    expect(entryInHtml('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });
});

describe('isNewer', () => {
  it('only when both are known and differ', () => {
    expect(isNewer('/assets/index-a.js', '/assets/index-b.js')).toBe(true);
    expect(isNewer('/assets/index-a.js', '/assets/index-a.js')).toBe(false);
    expect(isNewer(null, '/assets/index-b.js')).toBe(false);
    expect(isNewer('/assets/index-a.js', null)).toBe(false);
  });
});
