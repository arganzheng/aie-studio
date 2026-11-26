// Pure helpers behind "@" mentions in the prompt box (model: web.FileMentions).
// A mention is plain text in the prompt — "@src/a.ts" — that the editor
// draws as a chip; nothing else is stored. Kept free of React/DOM so the
// trigger, ranking and recognition rules are unit-testable.
import type { CommandItem } from './commandPicker';
import { timeAgo } from './sessionList';

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

// What a mention is drawn as. `send`: what goes out in its place when the
// prompt is sent (absent = the text as it is).
// `open`: the chip can be clicked, and this is what it opens (a session id).
export type MentionInfo = { kind: 'file' | 'session'; label: string; title: string; send?: string; open?: string };
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

// ----- sessions (model: web.SessionMentions) --------------------------------
// A session mention is "@session:<id>" in the prompt, drawn as a chip with
// the session's title. claude knows nothing of that form, so on sending it
// becomes a line it can act on: the title and the id, which the read_session
// tool takes (server.ReadSession).

export const SESSIONS_GROUP = 'Sessions';
export const SESSION_PREFIX = 'session:';

export type MentionSession = { id: string; title: string; kind: 'claude' | 'devin'; updatedAt: number };

const kindName = (k: MentionSession['kind']) => (k === 'claude' ? 'Claude' : 'Devin');

export function sessionMentionText(id: string): string {
  return `@${SESSION_PREFIX}${id}`;
}

// What the prompt says in place of the mention when it is sent.
export function sessionSendText(s: MentionSession): string {
  return `[session "${s.title.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}" (${kindName(s.kind)}, id ${s.id})]`;
}

export function sessionMentionResolver(sessions: ReadonlyMap<string, MentionSession>): MentionResolver {
  return (token) => {
    if (!token.startsWith(SESSION_PREFIX)) return null;
    const s = sessions.get(token.slice(SESSION_PREFIX.length));
    return s ? { kind: 'session', label: s.title, title: `${s.title} — ${kindName(s.kind)} session ${s.id}. Click to open it.`, send: sessionSendText(s), open: s.id } : null;
  };
}

// The first resolver that knows the token.
export function combineResolvers(...resolvers: Array<MentionResolver | null>): MentionResolver | null {
  const rs = resolvers.filter((r): r is MentionResolver => r != null);
  if (rs.length === 0) return null;
  return (token) => { for (const r of rs) { const i = r(token); if (i) return i; } return null; };
}

// Picker rows: sessions whose title has the query, latest first.
export function sessionItems(sessions: readonly MentionSession[], query: string, now: number, limit = 50): CommandItem[] {
  const q = query.toLowerCase();
  return sessions
    .filter((s) => !q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().startsWith(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((s) => ({
      group: SESSIONS_GROUP,
      name: s.id,
      label: s.title,
      description: `${kindName(s.kind)} · ${timeAgo(s.updatedAt, now)}`,
      insert: `${sessionMentionText(s.id)} `,
    }));
}

// The prompt as it is sent: each mention that has a `send` form replaced by it.
export function expandMentions(text: string, resolve: MentionResolver | null): string {
  if (!resolve) return text;
  let out = text;
  for (const r of findMentions(text, resolve).reverse()) {
    if (r.info.send != null) out = out.slice(0, r.from) + r.info.send + out.slice(r.to);
  }
  return out;
}
