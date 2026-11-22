import { describe, expect, it } from 'vitest';
import { cleanAutomation, minuteKey, renderPrompt, type Automation } from '../automations.js';

const base = { name: 'Nightly triage', prompt: 'Triage new issues', trigger: { kind: 'schedule', cron: '0 9 * * *' }, action: { kind: 'new-session', projectId: 'p1' } };

describe('cleanAutomation', () => {
  it('accepts a schedule that opens a new session', () => {
    const a = cleanAutomation(base) as Automation;
    expect(a).toMatchObject({ name: 'Nightly triage', enabled: true, trigger: { kind: 'schedule', cron: '0 9 * * *' }, action: { kind: 'new-session', projectId: 'p1' } });
    expect(a.id).toMatch(/[0-9a-f-]{36}/);
  });
  it('says what is wrong', () => {
    expect(cleanAutomation({ ...base, name: ' ' })).toEqual({ error: 'Give it a name' });
    expect(cleanAutomation({ ...base, prompt: '' })).toEqual({ error: 'Write the prompt it sends' });
    expect((cleanAutomation({ ...base, trigger: { kind: 'schedule', cron: '61 * * * *' } }) as any).error).toMatch(/^Schedule: minute/);
    expect(cleanAutomation({ ...base, trigger: { kind: 'x' } })).toEqual({ error: 'Pick a trigger: a schedule, a webhook or a condition' });
    expect(cleanAutomation({ ...base, action: { kind: 'message', projectId: 'p1', sessionId: 'nope' } })).toEqual({ error: 'Pick the session to write to' });
  });
  it('gives a webhook a secret token and keeps it across edits', () => {
    const a = cleanAutomation({ ...base, trigger: { kind: 'webhook' } }) as Automation;
    expect(a.trigger.kind === 'webhook' && a.trigger.token.length).toBeGreaterThanOrEqual(16);
    const edited = cleanAutomation({ ...base, name: 'Renamed', trigger: { kind: 'webhook', token: 'attacker-chosen-token-123' } }, a) as Automation;
    expect(edited.trigger).toEqual(a.trigger);
    expect([edited.id, edited.createdAt]).toEqual([a.id, a.createdAt]);
  });
});

describe('renderPrompt', () => {
  const now = new Date('2026-11-23T09:05:00');
  it('fills {{date}} and {{body}}', () => {
    expect(renderPrompt('Report for {{date}}: {{ body }}', { body: '{"a":1}', now })).toBe('Report for 2026-11-23 09:05: {"a":1}');
  });
  it('adds a webhook body after a prompt that does not place it', () => {
    expect(renderPrompt('Look at this', { body: 'x', now })).toBe('Look at this\n\n---\nWebhook payload:\n```\nx\n```');
    expect(renderPrompt('Look at this', { body: null, now })).toBe('Look at this');
  });
  it('keys minutes so a schedule fires once per minute', () => {
    expect(minuteKey(new Date('2026-11-23T09:05:10'))).toBe(minuteKey(new Date('2026-11-23T09:05:50')));
  });
});

describe('condition triggers', () => {
  const cond = { ...base, trigger: { kind: 'condition', on: 'pr_merged', ref: 'https://github.com/o/r/pull/12' } };
  it('reads a pull request as a URL or owner/repo#n', async () => {
    const { parsePrInput } = await import('../automations.js');
    expect(parsePrInput('https://github.com/o/r/pull/12/files')).toEqual({ repo: 'o/r', pr: 12 });
    expect(parsePrInput('arganzheng/aie-studio#56')).toEqual({ repo: 'arganzheng/aie-studio', pr: 56 });
    expect(parsePrInput('#56')).toBeNull();
  });
  it('arms when created, keeps waiting across edits, rearms when the condition changes or it is turned on again', () => {
    const a = cleanAutomation(cond) as Automation;
    expect(a.trigger).toMatchObject({ kind: 'condition', on: 'pr_merged', repo: 'o/r', pr: 12, timeoutHours: 72 });
    const armed = (a.trigger as any).armedAt;
    const renamed = cleanAutomation({ ...cond, name: 'x', trigger: { ...cond.trigger } }, { ...a, trigger: { ...a.trigger, armedAt: 1 } as any }) as Automation;
    expect((renamed.trigger as any).armedAt).toBe(1);
    const changed = cleanAutomation({ ...cond, trigger: { ...cond.trigger, on: 'pr_checks' } }, { ...a, trigger: { ...a.trigger, armedAt: 1 } as any }) as Automation;
    expect((changed.trigger as any).armedAt).toBeGreaterThanOrEqual(armed);
    const backOn = cleanAutomation({ ...cond, enabled: true }, { ...a, enabled: false, trigger: { ...a.trigger, armedAt: 1 } as any }) as Automation;
    expect((backOn.trigger as any).armedAt).toBeGreaterThan(1);
  });
  it('a deploy condition takes a commit instead', () => {
    expect(cleanAutomation({ ...base, trigger: { kind: 'condition', on: 'deployed', commit: 'abc1234' } })).toMatchObject({ trigger: { kind: 'condition', on: 'deployed', commit: 'abc1234' } });
    expect((cleanAutomation({ ...base, trigger: { kind: 'condition', on: 'pr_merged', ref: 'nope' } }) as any).error).toMatch(/owner\/repo#12/);
  });
  it('labels what a condition saw in the prompt', () => {
    expect(renderPrompt('Deploy it', { body: 'PR #12 was merged.', now: new Date(), label: 'What happened' })).toBe('Deploy it\n\n---\nWhat happened:\n```\nPR #12 was merged.\n```');
  });
});
