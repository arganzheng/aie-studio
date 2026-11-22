import { describe, expect, it } from 'vitest';
import { parseWatchReport } from '../watchReport';
import { sessionStatus, type SessionRow } from '../sessionList';

describe('parseWatchReport', () => {
  it('reads a met report and drops the lines meant for the agent', () => {
    const r = parseWatchReport('[Watch "PR #49 merged" met]\n\nPR #49 "Add it" was merged (merge commit e41841c).\n\nWhen you set this watch you planned to: clean up\n\nThe user has not replied since: treat this as their go-ahead and carry on. Stop to ask only for a decision that is really theirs.');
    expect(r).toEqual({ label: 'PR #49 merged', state: 'met', body: 'PR #49 "Add it" was merged (merge commit e41841c).' });
  });
  it('reads failed and timed-out reports', () => {
    expect(parseWatchReport('[Watch "PR #3 merged" cannot be met]\n\nPR #3 was closed without being merged.\n\nDecide what to do: x')?.state).toBe('cannot be met');
    expect(parseWatchReport('[Watch "abc1234 deployed" timed out]\n\nNothing settled it within 24 hours.\n\nLast seen: x.\n\nTell the user where things stand. y')?.body).toBe('Nothing settled it within 24 hours.\n\nLast seen: x.');
  });
  it('ignores anything else', () => {
    expect(parseWatchReport('[Watch "x" met] no blank line')).toBeNull();
    expect(parseWatchReport('hello')).toBeNull();
  });
});

describe('sessionStatus with watches', () => {
  const row: SessionRow = { kind: 'claude', sessionId: 's', projectId: 'p', title: 't', updatedAt: 0, live: null, state: null, archived: false } as SessionRow;
  it('adds what it goes on at to the question it ended on', () => {
    expect(sessionStatus({ ...row, status: { tone: 'needs-you', label: 'Confirm merge' }, watches: [{ id: 'a', label: 'PR #49 merged' }] }, false, 0))
      .toEqual({ tone: 'awaiting', label: 'Confirm merge · ⏳ PR #49 merged' });
  });
  it('shows the watch alone when the agent left no status', () => {
    expect(sessionStatus({ ...row, watches: [{ id: 'a', label: 'PR #1 checks done' }, { id: 'b', label: 'PR #1 merged' }] }, false, 0))
      .toEqual({ tone: 'idle', label: '⏳ PR #1 checks done, PR #1 merged' });
  });
  it('a running turn still wins', () => {
    expect(sessionStatus({ ...row, state: 'running', watches: [{ id: 'a', label: 'x' }] } as SessionRow, false, 0).tone).toBe('running');
  });
});
