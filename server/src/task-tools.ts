import type { Settings } from './store.js';

// Model: web.PlanStrip — recent claude CLIs (2.1.3xx) leave the task-list
// tools (TaskCreate / TaskUpdate / TaskList / TaskGet) off unless this is set;
// without them Claude keeps no list and the plan strip has nothing to show.
export const TASK_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

// Settings.taskListTools: absent = on.
export function taskToolsOn(settings: Pick<Settings, 'taskListTools'> | null | undefined): boolean {
  return settings?.taskListTools !== false;
}

// The extra env a Claude process gets for the setting; empty when off, so a
// value set on the server's own environment still wins.
export function taskToolsEnv(on: boolean): Record<string, string> {
  return on ? { [TASK_TOOLS_ENV]: '1' } : {};
}
