import { describe, expect, it } from 'vitest';
import { applyTaskEvent, runningTasks, type SdkTask } from '../sdk-session.js';

describe('runningTasks', () => {
  it('lists the tasks still running, for the client', () => {
    const tasks = new Map<string, SdkTask>();
    applyTaskEvent(tasks, { type: 'system', subtype: 'task_started', task_id: 'b1', description: 'npm test', is_backgrounded: true });
    applyTaskEvent(tasks, { type: 'system', subtype: 'task_started', task_id: 'a1', description: 'Review the post', subagent_type: 'general-purpose' });
    expect(runningTasks(tasks)).toEqual([
      { taskId: 'b1', description: 'npm test', subagent: false },
      { taskId: 'a1', description: 'Review the post', subagent: true },
    ]);
    applyTaskEvent(tasks, { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    expect(runningTasks(tasks).map((t) => t.taskId)).toEqual(['a1']);
  });
});

import { handedOutActivity, runningSubagents } from '../sdk-session.js';

describe('runningSubagents', () => {
  const started = (task_id: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id, description: task_id, ...extra });
  it('counts subagents that are still running, not background commands', () => {
    const tasks = new Map();
    applyTaskEvent(tasks, started('a1', { subagent_type: 'general-purpose' }));
    applyTaskEvent(tasks, started('a2', { subagent_type: 'Explore' }));
    applyTaskEvent(tasks, started('sh1'));
    expect(runningSubagents(tasks)).toBe(2);
    applyTaskEvent(tasks, { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
    expect(runningSubagents(tasks)).toBe(1);
    applyTaskEvent(tasks, { type: 'system', subtype: 'task_updated', task_id: 'a2', patch: { status: 'killed' } });
    expect(runningSubagents(tasks)).toBe(0);
    // The background command is still going, and does not hold the session.
    expect(runningTasks(tasks).map((t) => t.taskId)).toEqual(['sh1']);
  });
  it('says so on the session row', () => {
    expect(handedOutActivity(1, 0)).toBe('Waiting for 1 subagent');
    expect(handedOutActivity(3, 0)).toBe('Waiting for 3 subagents');
    expect(handedOutActivity(0, 1)).toBe('Waiting for 1 child session');
    expect(handedOutActivity(2, 4)).toBe('Waiting for 2 subagents and 4 child sessions');
    expect(handedOutActivity(0, 0)).toBe('');
  });
});
