import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUT_HOURS, MAX_TIMEOUT_HOURS, MAX_WATCHES_PER_SESSION, NO_CHECKS_GRACE_MS, evaluate, nextCheckDelay, normalizeWatches,
  parsePrRef, prKey, timeoutMs, watchLabel, watchRefusal, watchReport, type PrSeen, type Watch,
} from '../watches.js';
import { applyWatches, type SessionRow } from '../sessions-index.js';

const pr = (state: 'open' | 'draft' | 'merged' | 'closed', checks: any[] = [], mergeCommit: string | null = null): PrSeen =>
  ({ state, title: 'Add it', mergeCommit, checks });
const MIN = 60_000;

describe('watchLabel / prKey', () => {
  it('names each kind', () => {
    expect(watchLabel({ kind: 'pr_merged', repo: 'o/r', pr: 49 })).toBe('PR #49 merged');
    expect(watchLabel({ kind: 'pr_checks', repo: 'o/r', pr: 49 })).toBe('PR #49 checks done');
    expect(watchLabel({ kind: 'deployed', repo: 'o/r', pr: 49 })).toBe('PR #49 deployed');
    expect(watchLabel({ kind: 'deployed', commit: 'e41841c36a61a7397' })).toBe('e41841c deployed');
  });
  it('shares one look per pull request', () => {
    expect(prKey({ kind: 'pr_merged', repo: 'o/r', pr: 1 })).toBe(prKey({ kind: 'deployed', repo: 'o/r', pr: 1 }));
    expect(prKey({ kind: 'deployed', commit: 'abcdef1' })).toBeNull();
  });
});

describe('evaluate', () => {
  const merged = { kind: 'pr_merged' as const, repo: 'o/r', pr: 49 };
  it('pr_merged: met on merge, failed on close, waiting otherwise', () => {
    expect(evaluate(merged, { pr: pr('merged', [], 'e41841c36a') }, 0)).toEqual({ verdict: 'met', text: 'PR #49 "Add it" was merged (merge commit e41841c).' });
    expect(evaluate(merged, { pr: pr('closed') }, 0).verdict).toBe('failed');
    expect(evaluate(merged, { pr: pr('open', [{ name: 't', state: 'pending' }]) }, 0)).toEqual({ verdict: 'waiting', text: 'open, checks: 0 passed, 1 running' });
  });
  it('a gh problem is only a reason to look again', () => {
    expect(evaluate(merged, { pr: { error: 'not logged in' } }, 0)).toEqual({ verdict: 'waiting', text: 'could not ask GitHub: not logged in' });
  });
  it('pr_checks: met when none is running, with the outcome', () => {
    const c = { kind: 'pr_checks' as const, repo: 'o/r', pr: 7 };
    expect(evaluate(c, { pr: pr('open', [{ name: 'a', state: 'pending' }, { name: 'b', state: 'pass' }]) }, 0).verdict).toBe('waiting');
    expect(evaluate(c, { pr: pr('open', [{ name: 'a', state: 'fail' }, { name: 'b', state: 'pass' }]) }, 0))
      .toEqual({ verdict: 'met', text: 'The checks of PR #7 "Add it" have finished: 1 passed, 1 failed (a).' });
  });
  it('pr_checks: no checks yet is waited out for a while', () => {
    const c = { kind: 'pr_checks' as const, repo: 'o/r', pr: 7 };
    expect(evaluate(c, { pr: pr('open') }, 0).verdict).toBe('waiting');
    expect(evaluate(c, { pr: pr('open') }, NO_CHECKS_GRACE_MS + 1).verdict).toBe('met');
  });
  it('deployed by PR: needs the merge, then the running code to include it', () => {
    const c = { kind: 'deployed' as const, repo: 'o/r', pr: 49 };
    expect(evaluate(c, { pr: pr('open') }, 0)).toEqual({ verdict: 'waiting', text: 'PR #49 "Add it" is not merged yet' });
    expect(evaluate(c, { pr: pr('closed') }, 0).verdict).toBe('failed');
    expect(evaluate(c, { pr: pr('merged', [], 'e41841c36a'), contains: false, serverHead: 'a378b2d55' }, 0))
      .toEqual({ verdict: 'waiting', text: 'the server runs a378b2d, which does not include e41841c yet' });
    expect(evaluate(c, { pr: pr('merged', [], 'e41841c36a'), contains: true, serverHead: 'fff0000aa' }, 0).verdict).toBe('met');
  });
  it('deployed by commit', () => {
    const c = { kind: 'deployed' as const, commit: 'e41841c36a' };
    expect(evaluate(c, { contains: null, serverHead: 'a378b2d55' }, 0).verdict).toBe('waiting');
    expect(evaluate(c, { contains: true, serverHead: 'a378b2d55' }, 0).text).toMatch(/includes e41841c: it was restarted at a378b2d/);
  });
});

describe('schedule and limits', () => {
  it('looks less often the longer it waits', () => {
    expect(nextCheckDelay(0)).toBe(30_000);
    expect(nextCheckDelay(15 * MIN)).toBe(2 * MIN);
    expect(nextCheckDelay(2 * 60 * MIN)).toBe(10 * MIN);
  });
  it('keeps the timeout within bounds', () => {
    expect(timeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_HOURS * 60 * MIN);
    expect(timeoutMs(-1)).toBe(DEFAULT_TIMEOUT_HOURS * 60 * MIN);
    expect(timeoutMs(1000)).toBe(MAX_TIMEOUT_HOURS * 60 * MIN);
    expect(timeoutMs(0.5)).toBe(30 * MIN);
  });
  it('refuses a sixth watch on one session; settled ones do not count', () => {
    const w = (i: number, sessionId = 's', settled = false) => ({ id: String(i), sessionId, ...(settled ? { outcome: { kind: 'met', text: '' } } : {}) }) as Watch;
    const five = Array.from({ length: MAX_WATCHES_PER_SESSION }, (_, i) => w(i));
    expect(watchRefusal(five, 's')).toMatch(/already has 5 watches/);
    expect(watchRefusal(five, 'other')).toBeNull();
    expect(watchRefusal(five.map((x, i) => w(i, 's', i === 0)), 's')).toBeNull();
  });
});

describe('watchReport', () => {
  const w = { label: 'PR #49 merged', then: 'Clean up the worktree.', createdAt: 0 };
  it('met: the facts, the plan, and the go-ahead', () => {
    const t = watchReport(w, { kind: 'met', text: 'PR #49 was merged.' });
    expect(t.split('\n\n')).toEqual(['[Watch "PR #49 merged" met]', 'PR #49 was merged.', 'When you set this watch you planned to: Clean up the worktree.', expect.stringMatching(/^The user has not replied since/)]);
  });
  it('failed and expired say what to do instead', () => {
    expect(watchReport(w, { kind: 'failed', text: 'closed' })).toMatch(/^\[Watch "PR #49 merged" cannot be met\][\s\S]*Decide what to do/);
    expect(watchReport(w, { kind: 'expired', text: 'Nothing settled it within 24 hours.' }, 'open')).toMatch(/^\[Watch "PR #49 merged" timed out\][\s\S]*Last seen: open\.[\s\S]*Tell the user/);
  });
});

describe('normalizeWatches / parsePrRef', () => {
  it('keeps good records and drops bad ones', () => {
    const good = { sessionId: 's', projectId: 'p', projectPath: '/x', condition: { kind: 'pr_merged', repo: 'o/r', pr: 3 }, createdAt: 1, deadline: 2, nextCheckAt: 1, checks: 0, lastSeen: '' };
    const out = normalizeWatches({ a: good, b: { ...good, condition: { kind: 'pr_merged', repo: 'o/r' } }, c: { ...good, condition: { kind: 'shell', cmd: 'rm -rf /' } }, d: null });
    expect(Object.keys(out)).toEqual(['a']);
    expect(out.a).toMatchObject({ id: 'a', label: 'PR #3 merged', then: '' });
    expect(normalizeWatches({ a: { ...good, outcome: { kind: 'met', text: 'x' } } }).a.outcome).toEqual({ kind: 'met', text: 'x' });
  });
  it('reads the repository off the PR url', () => {
    expect(parsePrRef({ number: 49, url: 'https://github.com/arganzheng/aie-studio/pull/49' })).toEqual({ repo: 'arganzheng/aie-studio', pr: 49 });
    expect(parsePrRef({ number: 1, url: 'https://gitlab.com/x/y/merge_requests/1' })).toBeNull();
  });
});

describe('applyWatches', () => {
  it('puts each Claude session\'s watches on its row', () => {
    const rows = [{ kind: 'claude', sessionId: 's1' }, { kind: 'claude', sessionId: 's2' }, { kind: 'devin', sessionId: 's1' }] as SessionRow[];
    const out = applyWatches(rows, [{ id: 'a', sessionId: 's1', label: 'PR #1 merged' }, { id: 'b', sessionId: 's1', label: 'PR #1 deployed' }] as Watch[]);
    expect(out.map((r) => r.watches)).toEqual([[{ id: 'a', label: 'PR #1 merged' }, { id: 'b', label: 'PR #1 deployed' }], undefined, undefined]);
  });
});
