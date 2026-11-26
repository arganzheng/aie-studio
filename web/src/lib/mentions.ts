// Pure helpers behind "@" mentions in the prompt box (model: web.FileMentions).
// A mention is plain text in the prompt — "@src/a.ts" — that the editor
// draws as a chip; nothing else is stored. Kept free of React/DOM so the
// trigger, ranking and recognition rules are unit-testable.
import type { CommandItem } from './commandPicker';

export const FILES_GROUP = 'Files';

// The "@query" being typed just before the cursor, if any: "@" at the start
// or after whitespace, then no whitespace up to the cursor. `from` is where
// the "@" is.
export function matchMentionQuery(textBeforeCursor: string): { from: number; query: string } | null {
  const m = /(?:^|\s)@([^\s@"]*)$/.exec(textBeforeCursor);
  if (!m) return null;
  return { from: textBeforeCursor.length - m[1].length - 1, query: m[1] };
}

// What goes in the prompt for a file. claude reads "@path" as a file
// reference; a path with whitespace is quoted so it stays one token.
export function fileMentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
export function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

// The files a query brings up, best first: the name is the query, starts
// with it, contains it; then the path contains it; then the path has its
// letters in order. Ties: shallower, then shorter, then by name. No query:
// the shallowest files, by name.
export function rankFiles(files: readonly string[], query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  const scored: Array<{ f: string; s: number; d: number }> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = baseName(lower);
    const s = !q ? 0
      : base === q ? 0
      : base.startsWith(q) ? 1
      : base.includes(q) ? 2
      : lower.includes(q) ? 3
      : isSubsequence(q, lower) ? 4
      : -1;
    if (s < 0) continue;
    let d = 0;
    for (let i = 0; i < f.length; i++) if (f[i] === '/') d++;
    scored.push({ f, s, d });
  }
  const byName = (a: string, b: string) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
  scored.sort((a, b) => a.s - b.s || a.d - b.d || (q ? a.f.length - b.f.length : 0) || byName(a.f, b.f));
  return scored.slice(0, limit).map((x) => x.f);
}

// Picker rows: the name, with the directory as the second line.
export function fileItems(files: readonly string[], query: string, limit = 50): CommandItem[] {
  return rankFiles(files, query, limit).map((f) => ({
    group: FILES_GROUP,
    name: f,
    label: baseName(f),
    description: dirName(f),
    insert: `${fileMentionText(f)} `,
  }));
}

// What a mention is drawn as.
export type MentionInfo = { kind: 'file'; label: string; title: string };
export type MentionResolver = (token: string) => MentionInfo | null;

// A file mention is a chip only when it names a file of the checkout, so
// "@someone" and e-mail addresses stay text.
export function fileMentionResolver(files: ReadonlySet<string>): MentionResolver {
  return (token) => (files.has(token) ? { kind: 'file', label: baseName(token), title: token } : null);
}

export type MentionRange = { from: number; to: number; info: MentionInfo };

const TRAILING = /[.,;:!?)\]}'。，；：！？）]+$/;

// Every mention in `text` that `resolve` knows, as ranges over the whole
// "@token" (quotes included). Punctuation that ends a sentence right after
// a mention is not part of it.
export function findMentions(text: string, resolve: MentionResolver): MentionRange[] {
  const out: MentionRange[] = [];
  const re = /(^|\s)@(?:"([^"\n]+)"|([^\s@"]+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index + m[1].length;
    if (m[2] != null) {
      const info = resolve(m[2]);
      if (info) out.push({ from, to: from + m[2].length + 3, info });
      continue;
    }
    let token = m[3];
    let info = resolve(token);
    if (!info) {
      const cut = token.replace(TRAILING, '');
      if (cut && cut !== token) { token = cut; info = resolve(token); }
    }
    if (info) out.push({ from, to: from + token.length + 1, info });
  }
  return out;
}
