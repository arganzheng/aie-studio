import { quoteBlock } from './review';

// Model: web.AddToChat — a selected passage dropped into the prompt input as
// context, without a comment. Pure text helpers; the panels own the input.

// Where a quote was taken from when it isn't a session message: the
// project-relative file path, plus the line span when it could be located.
export type QuoteSource = { path: string; lines?: [number, number] | null };

// The selection as it should be quoted: blank lines around it dropped, but
// the first line's indentation kept (it matters for code).
export function cleanSelection(raw: string): string {
  return raw.replace(/^(?:[^\S\n]*\n)+/, '').replace(/\s+$/, '');
}

function sourceLabel(source: QuoteSource): string {
  if (!source.lines) return source.path;
  const [from, to] = source.lines;
  return from === to ? `${source.path}:${from}` : `${source.path}:${from}-${to}`;
}

// The text appended to the input: an optional "`path:lines`:" line, the
// passage as a markdown blockquote, then a blank line so whatever the user
// types next starts a new paragraph instead of continuing the quote.
export function composeQuote(quote: string, source?: QuoteSource): string {
  const head = source ? `\`${sourceLabel(source)}\`:\n` : '';
  return `${head}${quoteBlock(quote)}\n\n`;
}

// 1-based [first, last] line of `selection` inside `source`, or null when it
// can't be pinned down. Rendered text differs from the file in whitespace
// (selection.toString() adds / drops newlines; markdown reflows), so compare
// with all whitespace removed. Only a unique match counts: a wrong line
// number is worse than none.
export function locateLines(source: string, selection: string): [number, number] | null {
  const needle = selection.replace(/\s+/g, '');
  if (!needle) return null;
  const chars: string[] = [];
  const lineOf: number[] = [];
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') { line++; continue; }
    if (/\s/.test(ch)) continue;
    chars.push(ch);
    lineOf.push(line);
  }
  const hay = chars.join('');
  const at = hay.indexOf(needle);
  if (at < 0 || hay.indexOf(needle, at + 1) >= 0) return null;
  return [lineOf[at], lineOf[at + needle.length - 1]];
}
