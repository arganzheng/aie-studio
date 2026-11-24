import { describe, expect, it } from 'vitest';
import { messageLink, messageLinkFromHash, messageTime, questionAbout } from '../messageActions';

describe('messageTime', () => {
  const now = new Date(2026, 10, 23, 15, 0).getTime();
  it('is the time of day for today', () => {
    expect(messageTime(new Date(2026, 10, 23, 10, 45).getTime(), now)).toBe('10:45');
  });
  it('adds the date for another day, and the year for another year', () => {
    expect(messageTime(new Date(2026, 10, 21, 9, 5).getTime(), now)).toBe('Nov 21 09:05');
    expect(messageTime(new Date(2025, 0, 2, 9, 5).getTime(), now)).toBe('Jan 2, 2025 09:05');
  });
});

describe('message links', () => {
  const l = { projectId: 'p1', sessionId: 'be698afd-9315-4bee-b769-3f353b902889', anchor: 'a:4c1e1d2a-0000-4000-8000-000000000000:2' };
  it('round-trips through the hash', () => {
    const url = messageLink('https://aies.oeeo9.cn/#p1', l);
    expect(url.startsWith('https://aies.oeeo9.cn/#msg=')).toBe(true);
    expect(messageLinkFromHash(new URL(url).hash)).toEqual(l);
  });
  it('rejects other hashes', () => {
    expect(messageLinkFromHash('#p1')).toBeNull();
    expect(messageLinkFromHash('#alert=%7B%7D')).toBeNull();
    expect(messageLinkFromHash('#msg=p1/not-a-session/a:x')).toBeNull();
    expect(messageLinkFromHash('#msg=p1/be698afd-9315-4bee-b769-3f353b902889/zz')).toBeNull();
  });
});

describe('questionAbout', () => {
  it('quotes the message, then asks', () => {
    expect(questionAbout('line 1\nline 2', 'Why?')).toBe('About this message from the conversation:\n\n> line 1\n> line 2\n\nWhy?');
  });
  it('cuts a long message', () => {
    expect(questionAbout('x'.repeat(10), 'q', 4)).toContain('> xxxx…');
  });
});
