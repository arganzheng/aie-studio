import { describe, it, expect } from 'vitest';
import { parseParentContext, withParentContext } from '../parentContext';

describe('parent context frame', () => {
  it('round-trips the summary and the user\'s own text', () => {
    const msg = withParentContext({ title: 'Add Apple Pay', summary: 'Goal: Apple Pay.\n\nDecided: unit tests only.' }, 'Draft the tests.\nKeep them short.');
    expect(msg.startsWith('[Context from parent session "Add Apple Pay"]\nGoal: Apple Pay.')).toBe(true);
    expect(parseParentContext(msg)).toEqual({ title: 'Add Apple Pay', summary: 'Goal: Apple Pay.\n\nDecided: unit tests only.', text: 'Draft the tests.\nKeep them short.' });
  });
  it('keeps a title with quotes or line breaks on one line', () => {
    const msg = withParentContext({ title: 'Fix "login"\nbug', summary: 's' }, 'go');
    expect(parseParentContext(msg)).toMatchObject({ title: 'Fix  login  bug', text: 'go' });
  });
  it('leaves ordinary messages alone', () => {
    expect(parseParentContext('Draft the tests.')).toBeNull();
    expect(parseParentContext('[Context from parent session "x"] no closing frame')).toBeNull();
  });
});
