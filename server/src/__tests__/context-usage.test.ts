import { describe, it, expect } from 'vitest';
import { mapContextUsage } from '../context-usage.js';

// Trimmed from a real getContextUsage({ detail: 'summary' }) answer on a
// fresh query (1M-window model).
const SAMPLE = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 141, color: 'promptBorder', kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 12839, color: 'inactive', kind: 'used' },
    { id: 'system_tools_deferred', name: 'System tools (deferred)', tokens: 22788, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { id: 'skills', name: 'Skills', tokens: 2281, color: 'warning', kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 0, color: 'purple', kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'inactive', kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 951739, color: 'promptBorder', kind: 'free' },
  ],
  totalTokens: 15261,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  percentage: 2,
  model: 'claude-opus-5-5',
  autoCompactThreshold: 967000,
  isAutoCompactEnabled: true,
  gridRows: [],
};

describe('mapContextUsage', () => {
  it('keeps window, usage and in-window categories; drops deferred and empty rows', () => {
    const c = mapContextUsage(SAMPLE, 42);
    expect(c).toMatchObject({ model: 'claude-opus-5-5', usedTokens: 15261, windowTokens: 1000000, percent: 2, autoCompactAt: 967000, fetchedAt: 42 });
    expect(c!.categories.map((x) => [x.id, x.kind])).toEqual([
      ['system_prompt', 'used'], ['system_tools', 'used'], ['skills', 'used'],
      ['autocompact_buffer', 'buffer'], ['free_space', 'free'],
    ]);
  });

  it('computes the percentage when missing and hides auto-compact when disabled', () => {
    const c = mapContextUsage({ ...SAMPLE, percentage: undefined, isAutoCompactEnabled: false, totalTokens: 50000, rawMaxTokens: 200000 });
    expect(c!.percent).toBe(25);
    expect(c!.autoCompactAt).toBeNull();
  });

  it('returns null without a usable window', () => {
    expect(mapContextUsage({ totalTokens: 10 })).toBeNull();
    expect(mapContextUsage(null)).toBeNull();
  });
});
