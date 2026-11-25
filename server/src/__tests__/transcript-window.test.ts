import { describe, expect, it } from 'vitest';
import { isPrompt, pageStart } from '../transcript-window.js';

const prompt = (text: string) => ({ type: 'user', message: { content: text } });
const tool = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } });
const result = () => ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });

describe('isPrompt', () => {
  it('is what the user wrote, not tool results or task notifications', () => {
    expect(isPrompt(prompt('go on'))).toBe(true);
    expect(isPrompt({ type: 'user', message: { content: [{ type: 'text', text: 'look' }, { type: 'image' }] } })).toBe(true);
    expect(isPrompt(result())).toBe(false);
    expect(isPrompt(prompt('<task-notification>\n<task-id>b1</task-id></task-notification>'))).toBe(false);
    expect(isPrompt(tool())).toBe(false);
  });
});

describe('pageStart', () => {
  const work = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? result() : tool()));
  // 0: prompt, 2 of work; 3: prompt, 60 of work; 64: prompt, 4 of work.
  const recs = [prompt('old'), ...work(2), prompt('do it'), ...work(60), prompt('and now'), ...work(4)];
  it('reaches back to the start of the turn the cut falls in', () => {
    expect(pageStart(recs, recs.length, 20)).toBe(3);
    expect(pageStart(recs, 64, 20)).toBe(3);
  });
  it('an older page starts at a turn start too, and pages meet', () => {
    expect(pageStart(recs, 3, 20)).toBe(0);
    expect(pageStart(recs, 64, 80)).toBe(0);
  });
  it('stays at `limit` when the cut is a prompt', () => {
    expect(pageStart(recs, recs.length, 5)).toBe(64);
  });
  it('goes to the very start when no prompt opens the transcript', () => {
    expect(pageStart(work(30), 30, 20)).toBe(0);
  });
  it('cuts a turn longer than the cap', () => {
    expect(pageStart(recs, 60, 20, 30)).toBe(40);
  });
});
