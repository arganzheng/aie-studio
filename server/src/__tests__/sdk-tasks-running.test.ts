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
