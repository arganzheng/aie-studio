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

export function sourceLabel(source: QuoteSource): string {
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

// Model: web.AddToChat (quote cards) — a quoted passage waiting above the
// prompt input as a card, not as text in the textarea. `origin` names where a
// session-message quote came from ("Claude message"); file quotes carry a
// source instead. `comment` is the user's remark on the passage (a Review
// comment sent straight to the input, model: web.SendCommentToPrompt): it
// travels on the card so it stays next to its quote. Cards are removable one
// by one and only become text when the prompt is sent.
export type ChatQuote = { quote: string; source?: QuoteSource; origin?: string; comment?: string };

// The card's first line: the file location, else the origin.
export function quoteCardLabel(q: ChatQuote): string {
  return q.source ? sourceLabel(q.source) : q.origin || 'Quote';
}

// The card's second line: the passage folded onto one line (CSS ellipsizes).
export function quoteCardPreview(q: ChatQuote): string {
  return q.quote.replace(/\s+/g, ' ').trim();
}

// Append quotes to the cards already pending, skipping exact repeats.
export function addQuotes(pending: readonly ChatQuote[], next: readonly ChatQuote[]): ChatQuote[] {
  const key = (q: ChatQuote) => `${quoteCardLabel(q)}\u0000${q.quote}\u0000${q.comment ?? ''}`;
  const seen = new Set(pending.map(key));
  const out = [...pending];
  for (const q of next) {
    if (seen.has(key(q))) continue;
    seen.add(key(q));
    out.push(q);
  }
  return out;
}

// One card as prompt text: the blockquote (with its file location), the
// comment right under it when there is one, then a blank line.
function composeCard(q: ChatQuote): string {
  if (!q.comment) return composeQuote(q.quote, q.source);
  return `${composeQuote(q.quote, q.source).replace(/\n+$/, '')}\n${q.comment}\n\n`;
}

// What actually gets sent: every card, then the typed text. Cards alone send
// without a trailing blank.
export function composeQuotedPrompt(quotes: readonly ChatQuote[], text: string): string {
  if (quotes.length === 0) return text;
  const head = quotes.map(composeCard).join('');
  return text.trim() ? head + text : head.replace(/\s+$/, '');
}
