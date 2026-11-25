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
  // prompt, then 60 records of work.
  const recs = [prompt('old'), tool(), result(), prompt('do it'), ...Array.from({ length: 60 }, (_, i) => (i % 2 ? result() : tool()))];
  it('reaches back to the start of the turn in progress', () => {
    expect(pageStart(recs, recs.length, 20, true)).toBe(3);
  });
  it('is just the last `limit` records otherwise, or when the turn starts within them', () => {
    expect(pageStart(recs, recs.length, 20, false)).toBe(recs.length - 20);
    expect(pageStart(recs.slice(0, 10), 10, 20, true)).toBe(0);
  });
  it('gives up beyond the cap', () => {
    expect(pageStart(recs, recs.length, 20, true, 30)).toBe(recs.length - 20);
  });
});
