import { describe, expect, it } from 'vitest';
import { bangCommand, isBangInput, splitBangTexts } from '../bang';

describe('bang input', () => {
  it('detects a leading !', () => {
    expect(isBangInput('!ls')).toBe(true);
    expect(isBangInput('  ! git status')).toBe(true);
    expect(isBangInput('hi !ls')).toBe(false);
  });
  it('extracts the command', () => {
    expect(bangCommand('! git status ')).toBe('git status');
    expect(bangCommand('!')).toBeNull();
    expect(bangCommand('ls')).toBeNull();
  });
});

describe('splitBangTexts', () => {
  it('splits bash-mode records from prompt text', () => {
    expect(
      splitBangTexts([
        '<bash-input>ls</bash-input>',
        '<bash-stdout>a\nb</bash-stdout><bash-stderr>warn</bash-stderr>',
        'what are these files?',
      ]),
    ).toEqual([
      { kind: 'input', command: 'ls' },
      { kind: 'output', stdout: 'a\nb', stderr: 'warn' },
      { kind: 'text', text: 'what are these files?' },
    ]);
  });
  it('unescapes closing tags and tolerates a missing stderr', () => {
    expect(splitBangTexts(['<bash-stdout><\\/bash-stdout></bash-stdout>'])).toEqual([
      { kind: 'output', stdout: '</bash-stdout>', stderr: '' },
    ]);
  });
  it('leaves text that merely mentions the tags alone', () => {
    expect(splitBangTexts(['see <bash-input>x</bash-input> above'])[0].kind).toBe('text');
  });
});
