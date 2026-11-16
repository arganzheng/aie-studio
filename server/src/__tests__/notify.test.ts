import { describe, expect, it } from 'vitest';
import { BACKLOG_MAX, BACKLOG_TTL_MS, eventsSince, pushBacklog, type SessionEvent } from '../notify.js';

function ev(at: number, id = String(at)): SessionEvent {
  return { id, kind: 'done', tabType: 'claude-sdk', projectId: 'p', sessionId: 's', title: null, at };
}

describe('pushBacklog', () => {
  it('appends and drops events past the TTL', () => {
    const now = BACKLOG_TTL_MS + 1000;
    expect(pushBacklog([ev(0), ev(2000)], ev(now), now).map((e) => e.at)).toEqual([2000, now]);
  });
  it('keeps only the newest BACKLOG_MAX', () => {
    let b: SessionEvent[] = [];
    for (let i = 1; i <= BACKLOG_MAX + 5; i++) b = pushBacklog(b, ev(i), i);
    expect(b).toHaveLength(BACKLOG_MAX);
    expect(b[0].at).toBe(6);
  });
});

describe('eventsSince', () => {
  const backlog = [ev(100), ev(200), ev(300)];
  it('returns nothing for a fresh page (no since)', () => {
    expect(eventsSince(backlog, null, 400)).toEqual([]);
    expect(eventsSince(backlog, NaN, 400)).toEqual([]);
  });
  it('returns only what the page has not seen', () => {
    expect(eventsSince(backlog, 100, 400).map((e) => e.at)).toEqual([200, 300]);
    expect(eventsSince(backlog, 300, 400)).toEqual([]);
  });
  it('skips events that expired while the page was away', () => {
    expect(eventsSince(backlog, 0, 250 + BACKLOG_TTL_MS).map((e) => e.at)).toEqual([300]);
  });
});
