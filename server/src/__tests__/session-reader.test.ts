import { describe, expect, it } from 'vitest';
import { devinLines, renderConversation, type ConvLine } from '../session-reader.js';

const S = { kind: 'claude' as const, sessionId: 'abc-123456', title: 'Fix login' };
const conv = (n: number, len = 10): ConvLine[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'ASSISTANT' as const : 'USER' as const, text: `m${i + 1} ${'x'.repeat(len)}` }));

describe('devinLines', () => {
  it('keeps what was said, drops tool traffic and empty messages, cuts long ones', () => {
    const lines = devinLines([
      { role: 'user', content: ' hi ' },
      { role: 'tool_call', content: 'ls' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'y'.repeat(5000) },
    ]);
    expect(lines.map((l) => l.role)).toEqual(['USER', 'ASSISTANT']);
    expect(lines[0].text).toBe('hi');
    expect(lines[1].text.endsWith('… [cut]')).toBe(true);
  });
});

describe('renderConversation', () => {
  it('says so when nothing was said', () => {
    expect(renderConversation(S, [])).toContain('Nothing has been said in it yet');
  });
  it('a short one whole, numbered', () => {
    const t = renderConversation(S, conv(3));
    expect(t).toContain('Session "Fix login" (Claude, id abc-123456): 3 messages');
    expect(t).toContain('All of it.');
    expect(t).toContain('#1 USER: m1');
    expect(t).toContain('#3 USER: m3');
  });
  it('a long one: the first message and the latest that fit, saying what is left out', () => {
    const t = renderConversation(S, conv(10, 100), {}, 450);
    expect(t).toContain('#1 USER: m1');
    expect(t).toContain('#10 ASSISTANT: m10');
    expect(t).not.toContain('#2 ASSISTANT');
    expect(t).toMatch(/messages 2 to \d+ are left out/);
    expect(t).toMatch(/\[… \d+ messages left out …\]/);
  });
  it('a range: from start, count messages, and where to go on', () => {
    const t = renderConversation(S, conv(10), { start: 4, count: 3 });
    expect(t).toContain('Messages 4 to 6. More follow: call again with start=7.');
    expect(t).toContain('#4 ASSISTANT: m4');
    expect(t).not.toContain('#7 ');
    expect(renderConversation(S, conv(10), { start: 9 })).toContain('Messages 9 to 10. That is the end of it.');
  });
  it('a range stops at the budget but always gives one message', () => {
    const t = renderConversation(S, conv(10, 100), { start: 2, count: 5 }, 150);
    expect(t).toContain('Messages 2 to 2.');
    expect(renderConversation(S, conv(3), { start: 99 })).toContain('Messages 3 to 3.');
  });
});
