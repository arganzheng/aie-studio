import { describe, expect, it } from 'vitest';
import { cleanSelection, composeQuote, locateLines } from '../addToChat';

describe('cleanSelection', () => {
  it('drops surrounding blank lines but keeps the first line indentation', () => {
    expect(cleanSelection('\n  \n    return x;\n  }\n\n')).toBe('    return x;\n  }');
  });
  it('is empty for whitespace-only selections', () => {
    expect(cleanSelection(' \n\t\n ')).toBe('');
  });
});

describe('composeQuote', () => {
  it('quotes every line and ends with a blank line', () => {
    expect(composeQuote('first\n\nsecond')).toBe('> first\n>\n> second\n\n');
  });
  it('prefixes the file path', () => {
    expect(composeQuote('pnpm 11', { path: 'README.md' })).toBe('`README.md`:\n> pnpm 11\n\n');
  });
  it('adds a line span, collapsing a single line', () => {
    expect(composeQuote('a\nb', { path: 'src/a.ts', lines: [12, 13] })).toBe('`src/a.ts:12-13`:\n> a\n> b\n\n');
    expect(composeQuote('a', { path: 'src/a.ts', lines: [7, 7] })).toBe('`src/a.ts:7`:\n> a\n\n');
  });
  it('omits the span when lines are unknown', () => {
    expect(composeQuote('a', { path: 'src/a.ts', lines: null })).toBe('`src/a.ts`:\n> a\n\n');
  });
});

describe('locateLines', () => {
  const src = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'].join('\n');

  it('finds a single-line selection', () => {
    expect(locateLines(src, 'return 2;')).toEqual([6, 6]);
  });
  it('finds a multi-line selection regardless of whitespace differences', () => {
    expect(locateLines(src, 'function b() {\nreturn 2;\n}')).toEqual([5, 7]);
    expect(locateLines(src, 'function a() {   return 1;')).toEqual([1, 2]);
  });
  it('returns null when the selection occurs more than once', () => {
    expect(locateLines(src, 'return')).toBeNull();
    expect(locateLines('aaa', 'aa')).toBeNull();
  });
  it('returns null when the selection is absent or blank', () => {
    expect(locateLines(src, 'return 3;')).toBeNull();
    expect(locateLines(src, '  \n ')).toBeNull();
  });
});
