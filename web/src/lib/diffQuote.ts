import type { QuoteSource } from './addToChat';

// Model: web.ChangesView → web.AddToChat — where a passage selected in a diff
// comes from. `rows` are the diff lines the selection touches, in order. The
// span is in the new file's numbering; a selection of removed lines only has
// no new numbers, so it is quoted with the old ones and the path says so.
export type DiffRowRef = { path: string; oldNo?: number; newNo?: number };

export function diffQuoteSource(rows: readonly DiffRowRef[]): QuoteSource | null {
  if (!rows.length) return null;
  const path = rows[0].path;
  // Spanning files: name the first, don't guess a line range.
  if (rows.some((r) => r.path !== path)) return { path, lines: null };
  const span = (ns: number[]): [number, number] | null => (ns.length ? [Math.min(...ns), Math.max(...ns)] : null);
  const fresh = span(rows.flatMap((r) => (r.newNo != null ? [r.newNo] : [])));
  if (fresh) return { path, lines: fresh };
  const old = span(rows.flatMap((r) => (r.oldNo != null ? [r.oldNo] : [])));
  return old ? { path: `${path} (before the change)`, lines: old } : { path, lines: null };
}

// One-letter badge for a file's status, as in `git status --short`.
export function statusLetter(status: string): string {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return 'U';
    default: return 'M';
  }
}
