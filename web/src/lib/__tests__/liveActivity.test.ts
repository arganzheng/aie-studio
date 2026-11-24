import { describe, expect, it } from 'vitest';
import { liveActivity } from '../liveActivity';

describe('liveActivity', () => {
  it('prefers the in-progress task, in its present-tense form', () => {
    const plan = [
      { text: 'Write tests', status: 'completed' as const },
      { text: 'Align the time', active: 'Aligning the time', status: 'in_progress' as const },
    ];
    expect(liveActivity(plan, [{ role: 'tool', name: 'Bash', input: { description: 'Run tests' } }])).toBe('Aligning the time');
    expect(liveActivity([{ text: 'Align the time', status: 'in_progress' }], [])).toBe('Align the time');
  });

  it('falls back to the last tool call of this turn, skipping task-list calls', () => {
    const msgs = [
      { role: 'user' },
      { role: 'tool', name: 'Grep', input: { pattern: 'foo' }, output: 'x' },
      { role: 'tool', name: 'Bash', input: { description: 'Run web tests', command: 'pnpm test' } },
      { role: 'tool', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, output: 'ok' },
    ];
    expect(liveActivity(null, msgs)).toBe('Run web tests');
    expect(liveActivity([{ text: 'Done', status: 'completed' }], msgs.slice(0, 2))).toBe('Searched foo');
  });

  it('does not reach back past the prompt', () => {
    expect(liveActivity(null, [{ role: 'tool', name: 'Read', input: { file_path: 'a.ts' }, output: '' }, { role: 'user' }])).toBe('Thinking');
  });
});
