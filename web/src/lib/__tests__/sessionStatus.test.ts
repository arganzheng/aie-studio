import { describe, expect, it } from 'vitest';
import { awaitingUser, parseStatus, stripStatus } from '../sessionStatus';

describe('stripStatus', () => {
  it('hides the status line, finished or still arriving', () => {
    expect(stripStatus('Which one?\n\n<!--status needs-you: Choose a name-->')).toBe('Which one?');
    expect(stripStatus('Which one?\n\n<!--status need')).toBe('Which one?');
    expect(stripStatus('Which one?\n\n<!-')).toBe('Which one?\n\n<!-');
  });
  it('leaves everything else as it is', () => {
    expect(stripStatus('plain')).toBe('plain');
    expect(stripStatus('a <!-- note --> b')).toBe('a <!-- note --> b');
    expect(stripStatus('see <!-- todo')).toBe('see <!-- todo');
  });
});

describe('parseStatus', () => {
  it('reads tone and phrase', () => {
    expect(parseStatus('x\n<!--status ready: PR is ready-->')).toEqual({ text: 'x', status: { tone: 'ready', label: 'PR is ready' } });
  });
});

describe('awaitingUser', () => {
  const ask = { role: 'assistant', text: 'bar or baz?\n<!--status needs-you: Choose a name-->' };
  it('is true when the last reply asks', () => {
    expect(awaitingUser([{ role: 'user', text: 'rename foo' }, ask])).toBe(true);
    expect(awaitingUser([ask, { role: 'tool' }])).toBe(true);
  });
  it('is false once the user wrote, or when the reply only reports', () => {
    expect(awaitingUser([ask, { role: 'user', text: 'bar' }])).toBe(false);
    expect(awaitingUser([{ role: 'assistant', text: 'Done.\n<!--status ready: PR is ready-->' }])).toBe(false);
    expect(awaitingUser([{ role: 'assistant', text: 'Done.' }])).toBe(false);
    expect(awaitingUser([])).toBe(false);
  });
});

describe('status lines of a tone the app does not know', () => {
  it('are hidden but carry no status', () => {
    expect(parseStatus('Running the build.\n<!--status working: Tier B+C running-->')).toEqual({ text: 'Running the build.', status: null });
    expect(stripStatus('Done.\n<!--status ready: PR is ready-->')).toBe('Done.');
  });
});
