import { describe, it, expect } from 'vitest';
import { shortTokens, contextTitle } from '../../components/ContextUsage';

describe('context usage formatting', () => {
  it('shortens token counts', () => {
    expect([1_000_000, 200_000, 37_490, 15_000, 999].map(shortTokens)).toEqual(['1M', '200k', '37.5k', '15k', '999']);
  });
  it('hover text shows window, used, free and auto-compact point', () => {
    const t = contextTitle({ model: 'claude-opus-5-5', usedTokens: 37490, windowTokens: 1_000_000, percent: 4, autoCompactAt: 967000, categories: [], fetchedAt: 0 });
    expect(t).toContain('Context: 37,490 / 1,000,000 tokens (4%)');
    expect(t).toContain('Window: 1M · claude-opus-5-5');
    expect(t).toContain('Free: 962,510 tokens');
    expect(t).toContain('Auto-compact at 967,000 tokens');
  });
});
