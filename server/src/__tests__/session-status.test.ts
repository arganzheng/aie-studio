import { describe, expect, it } from 'vitest';
import { normalizeStatus, parseStatus, stripStatus, STATUS_LABEL_MAX } from '../session-status.js';
import { normalizeSessionMeta } from '../store.js';
import { applySessionMeta, forgetSession } from '../sessions-index.js';

describe('parseStatus', () => {
  it('reads the status line and takes it out of the reply', () => {
    expect(parseStatus('Which one, bar or baz?\n\n<!--status needs-you: Choose bar or baz-->')).toEqual({
      text: 'Which one, bar or baz?',
      status: { tone: 'needs-you', label: 'Choose bar or baz' },
    });
    expect(parseStatus('Opened #12.\n<!-- status ready : PR is ready -->').status).toEqual({ tone: 'ready', label: 'PR is ready' });
  });
  it('leaves a reply without one untouched', () => {
    expect(parseStatus('Done.\n')).toEqual({ text: 'Done.\n', status: null });
    expect(parseStatus('a <!-- note --> b').status).toBeNull();
    expect(parseStatus(undefined)).toEqual({ text: '', status: null });
  });
  it('keeps the last of several, ignores an empty one, caps the label', () => {
    expect(parseStatus('<!--status ready: One-->\nx\n<!--status needs-you: Two-->').status).toEqual({ tone: 'needs-you', label: 'Two' });
    expect(parseStatus('x <!--status ready: -->')).toEqual({ text: 'x', status: null });
    expect(parseStatus(`<!--status ready: ${'w'.repeat(80)}-->`).status!.label.length).toBe(STATUS_LABEL_MAX);
  });
  it('ignores unknown tones', () => {
    expect(parseStatus('x <!--status busy: Working-->')).toEqual({ text: 'x <!--status busy: Working-->', status: null });
  });
});

describe('stripStatus', () => {
  it('hides a marker that is still arriving', () => {
    expect(stripStatus('Which one?\n\n<!--')).toBe('Which one?');
    expect(stripStatus('Which one?\n\n<!--status needs-you: Cho')).toBe('Which one?');
    expect(stripStatus('Which one?\n\n<!--status needs-you: Choose-->')).toBe('Which one?');
  });
  it('leaves other unfinished comments alone', () => {
    expect(stripStatus('see <!-- todo')).toBe('see <!-- todo');
  });
});

describe('status in the session meta', () => {
  it('survives a round trip and drops junk', () => {
    const meta = normalizeSessionMeta({ status: { 'claude:a': { tone: 'ready', label: ' PR is ready ' }, 'claude:b': { tone: 'x', label: 'y' }, 'claude:c': 'no' } });
    expect(meta.status).toEqual({ 'claude:a': { tone: 'ready', label: 'PR is ready' } });
    expect(normalizeStatus({ tone: 'needs-you', label: '' })).toBeNull();
  });
  it('is laid over the rows and forgotten with the session', () => {
    const meta = normalizeSessionMeta({ status: { 'claude:a': { tone: 'needs-you', label: 'Confirm scope' } } });
    const row = { kind: 'claude' as const, sessionId: 'a', projectId: 'p', title: 't', updatedAt: 1, live: null, state: null };
    expect(applySessionMeta([row, { ...row, sessionId: 'b' }], meta).map((r) => r.status)).toEqual([{ tone: 'needs-you', label: 'Confirm scope' }, undefined]);
    expect(forgetSession(meta, 'claude:a').status).toEqual({});
  });
});
