import { describe, expect, it } from 'vitest';
import { childLinkOfTool } from '../childLink';
import { costLabel, sessionStatus, type SessionRow } from '../sessionList';

describe('childLinkOfTool', () => {
  const id = 'c09e1285-e04e-44e5-9e6c-1ad40fa3258c';
  it('finds the child a spawn opened, once the tool has answered', () => {
    expect(childLinkOfTool('mcp__aie__spawn_child_session', { title: 'Essay' }, `Started child session "Essay" (id ${id}). Budget: $2.00.`)).toEqual({ sessionId: id, title: 'Essay' });
    expect(childLinkOfTool('mcp__aie__spawn_child_session', { title: 'Essay' }, undefined)).toBeNull();
    expect(childLinkOfTool('mcp__aie__spawn_child_session', { title: 'Essay' }, 'prompt is required.')).toBeNull();
  });
  it('finds the child a send or a stop names', () => {
    expect(childLinkOfTool('mcp__aie__send_to_child_session', { child_id: id, message: 'x' }, undefined)).toEqual({ sessionId: id });
    expect(childLinkOfTool('stop_child_session', { child_id: id }, 'Stopping')).toEqual({ sessionId: id });
    expect(childLinkOfTool('mcp__aie__send_to_child_session', { child_id: '../etc' }, undefined)).toBeNull();
  });
  it('ignores other tools', () => {
    expect(childLinkOfTool('Bash', { command: `echo (id ${id})` }, `(id ${id})`)).toBeNull();
    expect(childLinkOfTool('mcp__aie__list_child_sessions', {}, `- ${id}`)).toBeNull();
  });
});

describe('row cost and activity', () => {
  const row = (o: Partial<SessionRow>): SessionRow => ({ kind: 'claude', sessionId: 's', projectId: 'p', title: 't', updatedAt: 0, live: 'sdk', state: 'running', archived: false, ...o });
  it('labels the cost, against the cap when there is one', () => {
    expect(costLabel({})).toBe('');
    expect(costLabel({ costUsd: 0.123 })).toBe('$0.12');
    expect(costLabel({ costUsd: 0.004 })).toBe('<$0.01');
    expect(costLabel({ costUsd: 0.004, budgetUsd: 0.5 })).toBe('<$0.01 / $0.50');
    expect(costLabel({ costUsd: 0.4, budgetUsd: 2 })).toBe('$0.40 / $2.00');
    expect(costLabel({ budgetUsd: 2 })).toBe('$0.00 / $2.00');
  });
  it('says what a running session is doing', () => {
    expect(sessionStatus(row({ activity: 'Bash: Run the tests' }), false, 0).label).toBe('Bash: Run the tests');
    expect(sessionStatus(row({}), false, 0).label).toBe('Running…');
    expect(sessionStatus(row({ state: 'awaiting', activity: 'x' }), false, 0).label).toBe('Needs your input');
  });
});
