import { describe, it, expect } from 'vitest';
import { messageText, transcriptDigest } from '../session-summary.js';
import { childBrief } from '../child-sessions.js';

const u = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const a = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } };

describe('messageText', () => {
  it('keeps what was said and drops tool traffic', () => {
    expect(messageText(u('Add Apple Pay'))).toEqual({ role: 'USER', text: 'Add Apple Pay' });
    expect(messageText({ type: 'user', message: { content: 'plain string' } })).toEqual({ role: 'USER', text: 'plain string' });
    expect(messageText(tool)).toBeNull();
    expect(messageText(toolResult)).toBeNull();
    expect(messageText({ type: 'system' })).toBeNull();
  });
  it('cuts one very long message', () => {
    expect(messageText(a('x'.repeat(10_000)))!.text.endsWith('… [cut]')).toBe(true);
  });
});

describe('transcriptDigest', () => {
  it('lays a short conversation out in order', () => {
    expect(transcriptDigest([u('Add Apple Pay'), tool, toolResult, a('Plan: three steps'), u('ok')]))
      .toBe('USER: Add Apple Pay\n\nASSISTANT: Plan: three steps\n\nUSER: ok');
  });
  it('keeps the first request and the end of a long one, noting the gap', () => {
    const msgs = [u('GOAL'), ...Array.from({ length: 50 }, (_, i) => a(`step ${i} ` + 'y'.repeat(100)))];
    const d = transcriptDigest(msgs, 100, 500);
    expect(d.startsWith('USER: GOAL')).toBe(true);
    expect(d).toMatch(/\[… \d+ earlier messages left out …\]/);
    expect(d).toContain('step 49');
    expect(d).not.toContain('step 0 ');
    expect(d.length).toBeLessThan(900);
  });
  it('reads a compacted session\'s own summary whole instead of cutting it like a first message', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.\n' + 'decision '.repeat(2000);
    const d = transcriptDigest([u(summary), a('Continuing.'), u('next')], 100, 500);
    expect(d.startsWith('SUMMARY OF THE EARLIER CONVERSATION')).toBe(true);
    expect(d.length).toBeGreaterThan(15_000);
    expect(d).toContain('ASSISTANT: Continuing.');
  });
  it('is empty when nothing was said', () => {
    expect(transcriptDigest([tool, toolResult])).toBe('');
  });
});

describe('childBrief', () => {
  it('tells the child where it stands, the background, and the task', () => {
    const b = childBrief({ parentTitle: 'Add Apple Pay', parentId: 'p-1', background: 'Unit tests only; UI is out of scope.', prompt: 'Draft the tests.' });
    expect(b).toContain('child session of "Add Apple Pay" (session p-1)');
    expect(b).toContain('your final answer is sent to it automatically');
    expect(b).toContain('Background from the parent session:\nUnit tests only; UI is out of scope.');
    expect(b.endsWith('Your task:\nDraft the tests.')).toBe(true);
  });
  it('leaves out an empty background and places the worktree note first', () => {
    const b = childBrief({ parentTitle: 'P', parentId: 'p', background: 'none', prompt: 'Do it.', worktree: 'You are working in your own git worktree.' });
    expect(b).not.toContain('Background from the parent session');
    expect(b.indexOf('own git worktree')).toBeLessThan(b.indexOf('Your task'));
  });
});
