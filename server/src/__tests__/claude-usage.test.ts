import { describe, it, expect } from 'vitest';
import { mapUsage } from '../claude-usage.js';

// Trimmed from a real Query.usage_EXPERIMENTAL_…({ skipBehaviors: true })
// answer on a Max plan: utilization is 0-100, resets_at is ISO 8601, unused
// windows are null, per-model weekly windows arrive in model_scoped[].
const SAMPLE = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 52, resets_at: '2026-11-17T11:40:00.180933+00:00' },
    seven_day: { utilization: 72, resets_at: '2026-11-17T11:00:00.180952+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: 'Fable', utilization: 84, resets_at: '2026-11-17T11:00:00.181095+00:00' }],
  },
};

describe('mapUsage', () => {
  it('maps 5-hour, weekly and per-model windows in display order', () => {
    const u = mapUsage(SAMPLE);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.plan).toBe('max');
    expect(u.windows.map((w) => [w.key, w.short, w.usedPercent])).toEqual([
      ['five_hour', '5h', 52],
      ['seven_day', 'wk', 72],
      ['model:Fable', 'Fable', 84],
    ]);
    expect(u.windows[0].resetAt).toBe('2026-11-17T11:40:00.180933+00:00');
  });

  it('skips windows with null utilization and clamps out-of-range values', () => {
    const u = mapUsage({
      ...SAMPLE,
      rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 130, resets_at: null } },
    });
    if (!u.ok) throw new Error('expected ok');
    expect(u.windows).toEqual([{ key: 'seven_day', label: 'Weekly', short: 'wk', usedPercent: 100, resetAt: null }]);
  });

  it('reports not_available for API-key / 3P sessions', () => {
    expect(mapUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }))
      .toEqual({ ok: false, error: 'not_available' });
  });
});
