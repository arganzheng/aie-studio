import { describe, expect, it } from 'vitest';
import { TASK_TOOLS_ENV, taskToolsEnv, taskToolsOn } from '../task-tools.js';

describe('task-list tools setting', () => {
  it('is on unless switched off', () => {
    expect(taskToolsOn({})).toBe(true);
    expect(taskToolsOn(null)).toBe(true);
    expect(taskToolsOn({ taskListTools: true })).toBe(true);
    expect(taskToolsOn({ taskListTools: false })).toBe(false);
  });

  it('adds the env var only when on', () => {
    expect(taskToolsEnv(true)).toEqual({ [TASK_TOOLS_ENV]: '1' });
    expect(taskToolsEnv(false)).toEqual({});
  });
});
