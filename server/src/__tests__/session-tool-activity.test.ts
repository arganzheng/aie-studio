import { describe, expect, it } from 'vitest';
import { activityAfter, showsTurnRunning, toolActivity, MAX_ACTIVITY_CHARS } from '../session-tool-activity.js';

describe('toolActivity', () => {
  it('names the tool and what it is working on', () => {
    expect(toolActivity('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Bash: Run the tests');
    expect(toolActivity('Edit', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('Edit: src/a.ts');
    expect(toolActivity('Grep', { pattern: 'foo' })).toBe('Grep: foo');
    expect(toolActivity('Read', { file_path: '/private/tmp/repo/calc.py' }, '/tmp/repo')).toBe('Read: calc.py');
  });
  it('shortens MCP tool names and falls back to the bare name', () => {
    expect(toolActivity('mcp__aie__spawn_child_session', { title: 'Draft tests', prompt: 'x' })).toBe('spawn_child_session: Draft tests');
    expect(toolActivity('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(toolActivity('', {})).toBe('');
  });
  it('keeps it to one short line', () => {
    const out = toolActivity('Bash', { command: `echo ${'x'.repeat(200)}\nsecond line` });
    expect(out.length).toBe(MAX_ACTIVITY_CHARS);
    expect(out).not.toContain('\n');
  });
});

describe('activityAfter', () => {
  const tool = (name: string, input: unknown) => ({ type: 'tool_use', name, input });
  it('takes the last top-level tool call of an assistant message', () => {
    expect(activityAfter({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, tool('Read', { file_path: 'a' }), tool('Grep', { pattern: 'b' })] } })).toBe('Grep: b');
  });
  it('clears on a result and ignores everything else', () => {
    expect(activityAfter({ type: 'result' })).toBe('');
    expect(activityAfter({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toBeNull();
    expect(activityAfter({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [tool('Read', { file_path: 'a' })] } })).toBeNull();
    expect(activityAfter({ type: 'stream_event' })).toBeNull();
  });
});

describe('showsTurnRunning', () => {
  it('sees a turn the agent started on its own', () => {
    expect(showsTurnRunning({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })).toBe(true);
    expect(showsTurnRunning({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } })).toBe(true);
  });
  it('ignores what can arrive while the session is idle', () => {
    expect(showsTurnRunning({ type: 'result', subtype: 'success' })).toBe(false);
    expect(showsTurnRunning({ type: 'system', subtype: 'task_notification' })).toBe(false);
    expect(showsTurnRunning({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [] } })).toBe(false);
    expect(showsTurnRunning(null)).toBe(false);
  });
});
