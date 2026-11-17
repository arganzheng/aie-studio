import { describe, it, expect } from 'vitest';
import { subagentProgress, subagentStatusLabel } from '../subagents';
import { sameTabRef, tabRef } from '../../types';

describe('subagent wording', () => {
  it('labels each status; a running one names its last tool', () => {
    expect(subagentStatusLabel({ status: 'running', lastTool: 'Bash' })).toBe('Running · Bash');
    expect(subagentStatusLabel({ status: 'running', lastTool: null })).toBe('Running');
    expect(subagentStatusLabel({ status: 'done', lastTool: 'Read' })).toBe('Done');
    expect(subagentStatusLabel({ status: 'failed', lastTool: null })).toBe('Failed');
    expect(subagentStatusLabel({ status: 'stopped', lastTool: null })).toBe('Stopped');
  });
  it('counts finished out of all for the parent row', () => {
    expect(subagentProgress([{ status: 'done' }, { status: 'running' }, { status: 'stopped' }, { status: 'running' }, { status: 'failed' }]))
      .toEqual({ settled: 3, total: 5, running: 2, label: '3/5' });
  });
});

describe('subagent tabs', () => {
  it('are identified by session + agent, so each subagent gets one tab', () => {
    const a = tabRef({ id: 't1', type: 'subagent', sessionId: 's1', agentId: 'a1' });
    expect(a).toEqual({ type: 'subagent', key: 's1:a1' });
    expect(sameTabRef(a, tabRef({ id: 't2', type: 'subagent', sessionId: 's1', agentId: 'a1' }))).toBe(true);
    expect(sameTabRef(a, tabRef({ id: 't3', type: 'subagent', sessionId: 's1', agentId: 'a2' }))).toBe(false);
  });
});
