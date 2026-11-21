import { describe, expect, it } from 'vitest';
import { planToolCalls } from '../plan-tools.js';

const use = (id: string, name: string, input: unknown) => ({ message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

describe('planToolCalls', () => {
  it('keeps plan tools with their result text and skips the rest', () => {
    expect(planToolCalls([
      use('a', 'Bash', { command: 'ls' }),
      result('a', 'x'),
      use('b', 'TaskCreate', { subject: 's' }),
      result('b', [{ type: 'text', text: 'Task #4 created successfully: s' }]),
      use('c', 'TaskUpdate', { taskId: '4', status: 'completed' }),
      { message: { content: 'plain text' } },
      {},
    ])).toEqual([
      { name: 'TaskCreate', input: { subject: 's' }, output: 'Task #4 created successfully: s' },
      { name: 'TaskUpdate', input: { taskId: '4', status: 'completed' } },
    ]);
  });

  it('drops everything before the last TodoWrite', () => {
    const calls = planToolCalls([
      use('a', 'TodoWrite', { todos: [] }),
      use('b', 'TaskCreate', { subject: 's' }),
      use('c', 'TodoWrite', { todos: [{ content: 'x', status: 'pending' }] }),
      use('d', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ]);
    expect(calls.map((c) => c.name)).toEqual(['TodoWrite', 'TaskUpdate']);
  });
});
