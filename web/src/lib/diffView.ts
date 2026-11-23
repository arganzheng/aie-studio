import type { DiffFile, DiffLine, SessionChangesResult } from '../api';

// Model: web.ChangesView "diff rendering" — the pure parts of how a file's
// diff is drawn: which words in a changed line actually changed, and the
// unchanged stretches between hunks that the user can open.

export type Seg = { text: string; changed: boolean };

// Words, runs of spaces, and single CJK characters / punctuation: Chinese
// has no spaces, so a word there is one character.
const TOKEN = /[A-Za-z0-9_$]+|\s+|[㐀-鿿豈-﫿]|[\s\S]/gu;
export function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

// Past this many cells the LCS is skipped and the whole middle is marked.
const LCS_CELL_CAP = 1_500_000;

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

// Pure: which parts of a removed line and the added line that replaced it
// changed. null when the two have too little in common for the marks to
// help (the lines are simply different).
export function wordDiff(oldText: string, newText: string): { old: Seg[]; new: Seg[] } | null {
  if (oldText === newText) return { old: [{ text: oldText, changed: false }], new: [{ text: newText, changed: false }] };
  const a = tokenize(oldText);
  const b = tokenize(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const keepA = new Array<boolean>(am.length).fill(false);
  const keepB = new Array<boolean>(bm.length).fill(false);
  if (am.length && bm.length && am.length * bm.length <= LCS_CELL_CAP) {
    // LCS table over the middle, then walk it back.
    const w = bm.length + 1;
    const t = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { keepA[i++] = true; keepB[j++] = true; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
  }
  const len = (ts: string[]) => ts.reduce((n, x) => n + x.length, 0);
  const same = len(a.slice(0, pre)) + len(a.slice(a.length - suf)) + len(am.filter((_, k) => keepA[k]));
  // Mostly unchanged text in common (spaces don't count as common ground).
  const commonNonSpace = [...a.slice(0, pre), ...a.slice(a.length - suf), ...am.filter((_, k) => keepA[k])].join('').replace(/\s+/g, '').length;
  const longer = Math.max(oldText.replace(/\s+/g, '').length, newText.replace(/\s+/g, '').length, 1);
  if (same === 0 || commonNonSpace / longer < 0.35) return null;
  const side = (all: string[], mid: string[], keep: boolean[]): Seg[] => merge([
    { text: all.slice(0, pre).join(''), changed: false },
    ...mid.map((text, k) => ({ text, changed: !keep[k] })),
    { text: all.slice(all.length - suf).join(''), changed: false },
  ]);
  return { old: side(a, am, keepA), new: side(b, bm, keepB) };
}

// Pure: for a hunk's lines, the word marks of each line that has a
// counterpart — the n-th removed line of a block pairs with the n-th added
// line right after it. Keyed by the line's index in the hunk.
export function pairWordDiffs(lines: readonly DiffLine[]): Map<number, Seg[]> {
  const out = new Map<number, Seg[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== '-') { i++; continue; }
    const delStart = i;
    while (i < lines.length && lines[i].t === '-') i++;
    const addStart = i;
    while (i < lines.length && lines[i].t === '+') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = wordDiff(lines[delStart + k].text, lines[addStart + k].text);
      if (!d) continue;
      out.set(delStart + k, d.old);
      out.set(addStart + k, d.new);
    }
  }
  return out;
}

// An unchanged stretch of the new file, shown folded: before hunk `before`
// (hunks.length = after the last one). Lines from..to (1-based, inclusive,
// new numbering); to null = to the end of a file whose length is unknown.
// oldOffset turns a new line number into the old one.
export type Gap = { before: number; from: number; to: number | null; oldOffset: number };

function lastNumbers(lines: readonly DiffLine[]): { oldNo: number; newNo: number } | null {
  let oldNo: number | null = null;
  let newNo: number | null = null;
  for (let i = lines.length - 1; i >= 0 && (oldNo == null || newNo == null); i--) {
    if (oldNo == null && lines[i].oldNo != null) oldNo = lines[i].oldNo!;
    if (newNo == null && lines[i].newNo != null) newNo = lines[i].newNo!;
  }
  return oldNo != null || newNo != null ? { oldNo: oldNo ?? 0, newNo: newNo ?? 0 } : null;
}

function hunkStart(header: string): { oldStart: number; newStart: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!m) return null;
  // A zero-length side starts *after* the line it names.
  const oldStart = m[2] === '0' ? Number(m[1]) + 1 : Number(m[1]);
  const newStart = m[4] === '0' ? Number(m[3]) + 1 : Number(m[3]);
  return { oldStart, newStart };
}

// Pure: the folded stretches of a file. Only for files whose new version is
// on disk and complete (not added, deleted, binary or cut short). newLines =
// the new version's line count, when known.
export function fileGaps(file: DiffFile, newLines?: number): Gap[] {
  if (file.binary || file.truncated || file.status === 'deleted' || file.status === 'added' || file.status === 'untracked') return [];
  const gaps: Gap[] = [];
  let nextNew = 1;
  let nextOld = 1;
  file.hunks.forEach((h, i) => {
    const s = hunkStart(h.header);
    if (!s) return;
    if (s.newStart > nextNew) gaps.push({ before: i, from: nextNew, to: s.newStart - 1, oldOffset: nextOld - nextNew });
    const end = lastNumbers(h.lines);
    nextNew = Math.max(nextNew, end && end.newNo ? end.newNo + 1 : s.newStart);
    nextOld = Math.max(nextOld, end && end.oldNo ? end.oldNo + 1 : s.oldStart);
  });
  if (file.hunks.length && (newLines == null || newLines >= nextNew)) {
    gaps.push({ before: file.hunks.length, from: nextNew, to: newLines ?? null, oldOffset: nextOld - nextNew });
  }
  return gaps;
}

// How much of a gap is open: lines shown from its top (just after the hunk
// above) and from its bottom (just before the hunk below).
export type GapOpen = { top: number; bottom: number };

// Pure: the line numbers (new numbering) of a gap that are shown above and
// below its fold bar, and how many stay folded (null = unknown, to the end).
export function gapView(gap: Gap, open: GapOpen, fileLines: number | null): { top: number[]; bottom: number[]; hidden: number | null } {
  const to = gap.to ?? fileLines;
  if (to == null) {
    return { top: [], bottom: [], hidden: null };
  }
  const size = Math.max(0, to - gap.from + 1);
  const top = Math.min(open.top, size);
  const bottom = Math.min(open.bottom, size - top);
  const range = (a: number, n: number) => Array.from({ length: n }, (_, k) => a + k);
  return { top: range(gap.from, top), bottom: range(to - bottom + 1, bottom), hidden: size - top - bottom };
}

// Pure: "src/lib/a.ts" → name "a.ts", dir "src/lib".
export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) };
}

// Pure: a file's identity across checkouts (session scopes span several).
export function fileKey(f: Pick<DiffFile, 'path' | 'repo'>): string {
  return `${f.repo ?? ''}\u0000${f.path}`;
}

// Pure: the new poll's files, with each file that did not change kept as the
// same object (and the same array when nothing changed), so its rendering
// (and word marks) is not redone every poll.
export function keepUnchangedFiles(prev: readonly DiffFile[] | null, next: DiffFile[]): DiffFile[] {
  if (!prev) return next;
  const old = new Map(prev.map((f) => [fileKey(f), f]));
  let same = prev.length === next.length;
  const files = next.map((f, i) => {
    const o = old.get(fileKey(f));
    if (o && JSON.stringify(o) === JSON.stringify(f)) { if (prev[i] !== o) same = false; return o; }
    same = false;
    return f;
  });
  return same ? (prev as DiffFile[]) : files;
}

// Pure: a session result's files in one list, each tagged with its checkout.
export function sessionFiles(r: SessionChangesResult): DiffFile[] {
  return r.repos.flatMap((x) => x.files.map((f) => (f.repo ? f : { ...f, repo: x.root })));
}

// Pure: "8:52 PM" today, "Nov 21, 8:52 PM" another day.
export function pointTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? t : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${t}`;
}
