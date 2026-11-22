import { describe, expect, it } from 'vitest';
import { ghProblem, parsePr } from '../changes-pr.js';

const run = (name: string, status: string, conclusion: string | null, startedAt = '2026-11-22T05:00:00Z', workflowName = 'CI') =>
  ({ __typename: 'CheckRun', name, status, conclusion, startedAt, workflowName, detailsUrl: `https://ci/${name}` });

describe('parsePr', () => {
  const base = { number: 7, title: 'Fix it', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'fix' };
  it('maps state, review and mergeability', () => {
    const p = parsePr({ ...base, statusCheckRollup: [] })!;
    expect([p.state, p.review, p.mergeable, p.base, p.head]).toEqual(['open', 'approved', 'yes', 'main', 'fix']);
    expect(parsePr({ ...base, isDraft: true })!.state).toBe('draft');
    expect(parsePr({ ...base, state: 'MERGED', reviewDecision: '', mergeable: 'UNKNOWN' })).toMatchObject({ state: 'merged', review: '', mergeable: 'unknown' });
    expect(parsePr({ ...base, state: 'CLOSED', reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' })).toMatchObject({ state: 'closed', review: 'changes-requested', mergeable: 'conflicts' });
    expect(parsePr({})).toBeNull();
  });
  it('sorts checks failed, running, passed, skipped', () => {
    const p = parsePr({ ...base, statusCheckRollup: [
      run('lint', 'COMPLETED', 'SUCCESS'),
      run('docs', 'COMPLETED', 'SKIPPED'),
      run('test', 'IN_PROGRESS', null),
      run('build', 'COMPLETED', 'FAILURE'),
      run('e2e', 'COMPLETED', 'TIMED_OUT'),
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', targetUrl: 'https://legacy' },
    ] })!;
    expect(p.checks.map((c) => `${c.state}:${c.name}`)).toEqual(['fail:build', 'fail:e2e', 'pending:ci/legacy', 'pending:test', 'pass:lint', 'skipped:docs']);
    expect(p.checks.find((c) => c.name === 'ci/legacy')!.url).toBe('https://legacy');
  });
  it('keeps only the latest run of a check run again', () => {
    const p = parsePr({ ...base, statusCheckRollup: [
      run('test', 'COMPLETED', 'FAILURE', '2026-11-22T05:00:00Z'),
      run('test', 'COMPLETED', 'SUCCESS', '2026-11-22T06:00:00Z'),
      run('test', 'COMPLETED', 'FAILURE', '2026-11-22T05:30:00Z', 'Other'),
    ] })!;
    expect(p.checks.map((c) => `${c.workflow}/${c.name}:${c.state}`)).toEqual(['Other/test:fail', 'CI/test:pass']);
  });
});

describe('ghProblem', () => {
  it('tells "no pull request" from gh being unusable', () => {
    expect(ghProblem('no pull requests found for branch "x"')).toEqual({ pr: null });
    expect(ghProblem('\nENOENT').unavailable).toMatch(/not installed/);
    expect(ghProblem('To get started with GitHub CLI, please run:  gh auth login').unavailable).toMatch(/not logged in/);
    expect(ghProblem('none of the git remotes configured for this repository point to a known GitHub host').unavailable).toMatch(/no GitHub remote/);
  });
});
