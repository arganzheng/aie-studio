import { describe, expect, it } from 'vitest';
import { sideEvent, sideQuestion } from '../side-chat.js';

describe('side chat', () => {
  it('frames the first question so the fork does not carry on the main task', () => {
    expect(sideQuestion('why X?', true)).toMatch(/^\[Side question \(\/btw\)\. The task above is still being carried on separately/);
    expect(sideQuestion('and Y?', false)).toBe('[Side question, continued.]\n\nand Y?');
  });
  it('passes on text deltas, answers with their tool calls, and the end', () => {
    expect(sideEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } })).toEqual({ type: 'delta', text: 'Hi' });
    expect(sideEvent({ type: 'stream_event', parent_tool_use_id: 'x', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } })).toBeNull();
    expect(sideEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] } }))
      .toEqual({ type: 'assistant', text: 'Looking', tools: ['Read src/a.ts'] });
    expect(sideEvent({ type: 'result', subtype: 'success', total_cost_usd: 0.01 })).toEqual({ type: 'done', ok: true, costUsd: 0.01, error: null });
    expect(sideEvent({ type: 'system', subtype: 'init', model: 'claude-x' })).toEqual({ type: 'ready', model: 'claude-x' });
    expect(sideEvent({ type: 'user' })).toBeNull();
  });
});
