import { describe, it, expect } from 'vitest';
import { encodeProjectDir, isAgentId, orderSubagents, subagentInfo, QUIET_RUNNING_MS } from '../subagents.js';
import { applyTaskEvent, type SdkTask } from '../sdk-session.js';

const base = { agentId: 'a1', startedAt: 1000, updatedAt: 2000, sessionLive: false, now: 10_000_000 };
const task = (over: Partial<SdkTask> = {}): SdkTask => ({
  taskId: 'a1', toolUseId: 'toolu_1', description: 'Count lines', subagentType: 'general-purpose',
  status: 'running', background: false, totalTokens: 1200, toolUses: 2, lastTool: 'Bash', ...over,
});

describe('subagentInfo', () => {
  it('reads type, description, model and background from the meta file', () => {
    const s = subagentInfo({ ...base, task: null, meta: { agentType: 'Explore', description: 'Find the router', requestShape: 'background', pickedEffortModel: 'claude-opus-5-5', parentAgentId: 'a0', finished: true } });
    expect(s).toMatchObject({ agentType: 'Explore', description: 'Find the router', background: true, model: 'claude-opus-5-5', parentAgentId: 'a0', status: 'done', canStop: false, taskId: null });
  });

  it('a live task wins: running and stoppable, with its progress', () => {
    const s = subagentInfo({ ...base, sessionLive: true, task: task(), meta: { description: 'Count lines' } });
    expect(s).toMatchObject({ status: 'running', canStop: true, taskId: 'a1', totalTokens: 1200, toolUses: 2, lastTool: 'Bash' });
  });

  it('a task the user stopped stays stopped even though the meta says finished', () => {
    expect(subagentInfo({ ...base, task: task({ status: 'stopped' }), meta: { finished: true } }).status).toBe('stopped');
    expect(subagentInfo({ ...base, task: task({ status: 'failed' }), meta: {} }).status).toBe('failed');
  });

  it('without task events: running only while the session is live and the file is fresh', () => {
    const fresh = { ...base, updatedAt: base.now - 5000, task: null, meta: {} };
    expect(subagentInfo({ ...fresh, sessionLive: true })).toMatchObject({ status: 'running', canStop: false });
    expect(subagentInfo({ ...fresh, sessionLive: false }).status).toBe('stopped');
    expect(subagentInfo({ ...fresh, sessionLive: true, updatedAt: base.now - QUIET_RUNNING_MS - 1 }).status).toBe('stopped');
  });
});

describe('orderSubagents', () => {
  it('puts children under their parent, siblings oldest first, orphans at the top level', () => {
    const list = [
      { agentId: 'c', parentAgentId: 'a', startedAt: 5 },
      { agentId: 'b', parentAgentId: null, startedAt: 3 },
      { agentId: 'a', parentAgentId: null, startedAt: 1 },
      { agentId: 'd', parentAgentId: 'gone', startedAt: 2 },
    ];
    expect(orderSubagents(list).map((s) => [s.agentId, s.depth])).toEqual([['a', 0], ['c', 1], ['d', 0], ['b', 0]]);
  });
});

describe('applyTaskEvent', () => {
  it('follows a subagent from start through progress to a user stop', () => {
    const tasks = new Map<string, SdkTask>();
    const ev = (subtype: string, rest: object) => ({ type: 'system', subtype, task_id: 'a1', ...rest });
    expect(applyTaskEvent(tasks, ev('task_started', { tool_use_id: 'toolu_1', description: 'Slow count', subagent_type: 'general-purpose', is_backgrounded: false }))).toBe(true);
    expect(tasks.get('a1')).toMatchObject({ status: 'running', toolUseId: 'toolu_1', description: 'Slow count', totalTokens: null });
    applyTaskEvent(tasks, ev('task_progress', { description: 'Running sleep', usage: { total_tokens: 18439, tool_uses: 2, duration_ms: 5 }, last_tool_name: 'Bash' }));
    expect(tasks.get('a1')).toMatchObject({ totalTokens: 18439, toolUses: 2, lastTool: 'Bash', description: 'Running sleep' });
    applyTaskEvent(tasks, ev('task_updated', { patch: { status: 'killed' } }));
    applyTaskEvent(tasks, ev('task_notification', { status: 'stopped' }));
    expect(tasks.get('a1')!.status).toBe('stopped');
  });

  it('ignores non-task messages', () => {
    const tasks = new Map<string, SdkTask>();
    expect(applyTaskEvent(tasks, { type: 'system', subtype: 'init' })).toBe(false);
    expect(applyTaskEvent(tasks, { type: 'assistant', task_id: 'x' })).toBe(false);
    expect(tasks.size).toBe(0);
  });
});

describe('ids and paths', () => {
  it('accepts agent ids, rejects path tricks', () => {
    expect(isAgentId('add40bd72388efef3')).toBe(true);
    expect(isAgentId('../x')).toBe(false);
    expect(isAgentId('')).toBe(false);
  });
  it('encodes a project directory the way Claude does', () => {
    expect(encodeProjectDir('/private/tmp/aie-tree/demo')).toBe('-private-tmp-aie-tree-demo');
    expect(encodeProjectDir('/Users/a/arganzheng.github.com')).toBe('-Users-a-arganzheng-github-com');
  });
});
