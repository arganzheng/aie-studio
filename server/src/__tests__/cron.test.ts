import { describe, expect, it } from 'vitest';
import { cronMatches, describeCron, nextRun, parseCron } from '../cron.js';

const at = (s: string) => new Date(s);
describe('cron', () => {
  it('parses fields, lists, ranges, steps and names', () => {
    const c = parseCron('*/15 9-17 * * mon-fri');
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 1,15 jan,jul 7').dow]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minute]).toEqual([5, 25, 45]);
  });
  it('refuses what is not a schedule', () => {
    expect(() => parseCron('* * * *')).toThrow(/five fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/minute/);
    expect(() => parseCron('* * * * funday')).toThrow(/day of week/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
  });
  it('matches local times, either day field when both are set', () => {
    const c = parseCron('30 9 * * 1-5');
    expect(cronMatches(c, at('2026-11-23T09:30:00'))).toBe(true); // Monday
    expect(cronMatches(c, at('2026-11-22T09:30:00'))).toBe(false); // Sunday
    const both = parseCron('0 0 13 * 5');
    expect(cronMatches(both, at('2026-11-13T00:00:00'))).toBe(true); // the 13th
    expect(cronMatches(both, at('2026-11-20T00:00:00'))).toBe(true); // a Friday
    expect(cronMatches(both, at('2026-11-21T00:00:00'))).toBe(false);
  });
  it('finds the next run', () => {
    expect(nextRun(parseCron('0 9 * * *'), at('2026-11-22T09:00:00'))?.toString()).toBe(at('2026-11-23T09:00:00').toString());
    expect(nextRun(parseCron('@monthly'), at('2026-11-22T10:00:00'))?.toString()).toBe(at('2026-12-01T00:00:00').toString());
    expect(nextRun(parseCron('0 0 29 2 *'), at('2026-11-22T10:00:00'))?.toString()).toBe(at('2028-02-29T00:00:00').toString());
  });
  it('describes common schedules', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00');
    expect(describeCron('30 8 * * 1-5')).toBe('Weekdays at 08:30');
    expect(describeCron('0 * * * *')).toBe('Every hour');
    expect(describeCron('0 18 * * fri')).toBe('Fri at 18:00');
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *');
  });
});
