import { describe, expect, it } from 'vitest';
import { addQuotes, cleanSelection, composeQuote, composeQuotedPrompt, locateLines, quoteCardLabel, quoteCardPreview } from '../addToChat';

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

describe('quote cards', () => {
  const file = { quote: 'export function average() {}', source: { path: 'src/math.ts', lines: [8, 12] as [number, number] } };
  const msg = { quote: 'line one\n  line two', origin: 'Claude message' };
  it('labels a card by file location, else origin', () => {
    expect(quoteCardLabel(file)).toBe('src/math.ts:8-12');
    expect(quoteCardLabel(msg)).toBe('Claude message');
    expect(quoteCardLabel({ quote: 'x' })).toBe('Quote');
  });
  it('folds the preview onto one line', () => {
    expect(quoteCardPreview(msg)).toBe('line one line two');
  });
  it('skips exact repeats when adding', () => {
    expect(addQuotes([msg], [msg, file])).toEqual([msg, file]);
    expect(addQuotes([msg], [{ ...msg, origin: 'Devin message' }])).toHaveLength(2);
  });
  it('sends cards as blockquotes before the typed text', () => {
    expect(composeQuotedPrompt([msg, file], 'Why?')).toBe(
      '> line one\n>   line two\n\n`src/math.ts:8-12`:\n> export function average() {}\n\nWhy?',
    );
  });
  it('sends quotes alone without a trailing blank, text alone unchanged', () => {
    expect(composeQuotedPrompt([msg], '  ')).toBe('> line one\n>   line two');
    expect(composeQuotedPrompt([], 'hi')).toBe('hi');
  });
  it('keeps a comment right under its quote', () => {
    const c = { quote: 'round half up', origin: 'Claude message', comment: 'Use half-to-even.' };
    expect(composeQuotedPrompt([c, file], 'Thanks.')).toBe(
      '> round half up\nUse half-to-even.\n\n`src/math.ts:8-12`:\n> export function average() {}\n\nThanks.',
    );
    expect(composeQuotedPrompt([c], '')).toBe('> round half up\nUse half-to-even.');
  });
  it('treats the same quote with a different comment as a new card', () => {
    const c = { quote: 'x', origin: 'Claude message', comment: 'one' };
    expect(addQuotes([c], [c])).toHaveLength(1);
    expect(addQuotes([c], [{ ...c, comment: 'two' }, { quote: 'x', origin: 'Claude message' }])).toHaveLength(3);
  });
});
