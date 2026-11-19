import { describe, expect, it } from 'vitest';
import { describePermission, isOwnTool, isSessionMode, permissionDenial, permissionSummary, planOf, planRejection, sessionRules } from '../permission-mode.js';
import { normalizeChildTerms } from '../store.js';

describe('session mode', () => {
  it('knows the four modes', () => {
    for (const m of ['plan', 'bypassPermissions', 'acceptEdits', 'auto']) expect(isSessionMode(m)).toBe(true);
    expect(isSessionMode('default')).toBe(false);
    expect(isSessionMode('dontAsk')).toBe(false);
    expect(isSessionMode(undefined)).toBe(false);
  });
  it('reads the plan of an ExitPlanMode call', () => {
    expect(planOf({ plan: '  # Do it\n' })).toBe('# Do it');
    expect(planOf({})).toBe('');
    expect(planOf(null)).toBe('');
  });
  it('words a rejection with and without feedback', () => {
    expect(planRejection(' also add tests ')).toContain('asks for changes:\n\nalso add tests\n\n');
    expect(planRejection('')).toContain('wait for their next message');
    expect(planRejection(undefined)).toContain('wait for their next message');
  });
  it('is kept with the session terms only when it is not the default', () => {
    expect(normalizeChildTerms({ a: { mode: 'plan' }, b: { mode: 'bypassPermissions' }, c: { mode: 'x' }, d: { mode: 'auto' }, e: { mode: 'acceptEdits' } })).toEqual({ a: { mode: 'plan' }, d: { mode: 'auto' }, e: { mode: 'acceptEdits' } });
    expect(normalizeChildTerms({ a: { mode: 'plan', resultSchema: { type: 'object' } } })).toEqual({ a: { mode: 'plan', resultSchema: { type: 'object' } } });
  });
});

describe('permission requests', () => {
  it('shows a shell command as the command', () => {
    const r = describePermission('Bash', { command: 'curl -sI https://example.com', description: 'Fetch the status line' }, { decisionReason: 'This command requires approval', suggestions: [{ type: 'addRules' }] });
    expect(r).toEqual({ tool: 'Bash', description: 'Fetch the status line', reason: 'This command requires approval', detail: 'curl -sI https://example.com', detailKind: 'command', canRemember: true });
    expect(permissionSummary(r)).toBe('Allow Bash: Fetch the status line?');
  });
  it('shows any other tool by its input, cut when long', () => {
    const r = describePermission('WebFetch', { url: 'https://example.com', prompt: 'x'.repeat(9000) });
    expect(r.detailKind).toBe('json');
    expect(r.detail.endsWith('… [cut]')).toBe(true);
    expect(r.canRemember).toBe(false);
    expect(permissionSummary(r)).toBe('Allow WebFetch?');
  });
  it('keeps a remembered rule to the session', () => {
    expect(sessionRules([{ type: 'addRules', destination: 'localSettings', rules: [1] }])).toEqual([{ type: 'addRules', destination: 'session', rules: [1] }]);
    expect(sessionRules(undefined)).toEqual([]);
  });
  it('never asks about the app\'s own tools', () => {
    expect(isOwnTool('mcp__aie__spawn_child_session')).toBe(true);
    expect(isOwnTool('mcp__github__create_issue')).toBe(false);
    expect(isOwnTool('Bash')).toBe(false);
  });
  it('words a denial', () => {
    expect(permissionDenial('use wget')).toBe('The user did not allow this action: use wget');
    expect(permissionDenial(undefined)).toContain('Do not retry it');
  });
});
