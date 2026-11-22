import { describe, expect, it } from 'vitest';
import { isCompactCommand, isInterruptNote, isSlashCommand } from '../steering';

describe('steering', () => {
  it('tells a slash command from text that starts with a path', () => {
    expect(isSlashCommand('/compact')).toBe(true);
    expect(isSlashCommand('  /compact keep the plan')).toBe(true);
    expect(isSlashCommand('/plugin:cmd arg')).toBe(true);
    expect(isSlashCommand('/tmp/x is the wrong path')).toBe(false);
    expect(isSlashCommand('/ hello')).toBe(false);
    expect(isSlashCommand('use /compact later')).toBe(false);
  });
  it('recognises the note the CLI leaves when a turn is stopped', () => {
    expect(isInterruptNote('[Request interrupted by user]')).toBe(true);
    expect(isInterruptNote('[Request interrupted by user for tool use]')).toBe(true);
    expect(isInterruptNote('[Request interrupted by user for tool use] and more')).toBe(false);
    expect(isInterruptNote('why was the [Request interrupted by user] shown?')).toBe(false);
  });
  it('knows /compact', () => {
    expect(isCompactCommand('/compact')).toBe(true);
    expect(isCompactCommand(' /compact keep the plan')).toBe(true);
    expect(isCompactCommand('/compacted')).toBe(false);
  });
});
