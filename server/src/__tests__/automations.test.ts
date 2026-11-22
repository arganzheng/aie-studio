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
    expect(cleanAutomation({ ...base, trigger: { kind: 'x' } })).toEqual({ error: 'Pick a trigger: a schedule or a webhook' });
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
