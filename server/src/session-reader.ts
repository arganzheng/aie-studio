import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { listProjects, type Project } from './store.js';
import { listProjectSessions } from './worktrees.js';
import { listDevinSessionsInDb, readDevinTranscript } from './devin.js';
import { messageText } from './session-summary.js';

// Model: server.ReadSession — what was said in another session, for a Claude
// session whose user mentioned it in the prompt (web.SessionMentions). Only
// the conversation: what the user and the assistant wrote, not the tool
// traffic. Nothing is summarised and nothing is read until Claude asks, so a
// mention costs nothing by itself.

export type ConvLine = { role: 'USER' | 'ASSISTANT'; text: string };
export type FoundSession = { kind: 'claude' | 'devin'; sessionId: string; title: string; project: Project };

// One message is shown up to this; a longer one is cut and says so.
const MESSAGE_CAP = 4_000;
// What one call returns at most.
export const READ_BUDGET = 30_000;
export const DEFAULT_COUNT = 20;

const ID_RE = /^[\w-]{6,80}$/;

// The session with this id among the caller's own projects (Claude sessions
// first), or null: an id is never taken on faith.
export async function findUserSession(uid: string, sessionId: string): Promise<FoundSession | null> {
  if (!ID_RE.test(sessionId)) return null;
  const projects = await listProjects(uid);
  for (const project of projects) {
    let list: Awaited<ReturnType<typeof listProjectSessions>> = [];
    try { list = await listProjectSessions(project.path); } catch {}
    const s = list.find((x) => x.sessionId === sessionId);
    if (s) return { kind: 'claude', sessionId, title: (s.customTitle || s.summary || '').trim() || sessionId.slice(0, 8), project };
  }
  for (const project of projects) {
    const s = listDevinSessionsInDb(project.path).find((x) => x.sessionId === sessionId);
    if (s) return { kind: 'devin', sessionId, title: s.title?.trim() || sessionId.slice(0, 8), project };
  }
  return null;
}

// Pure: a Devin transcript's user and assistant messages as lines.
export function devinLines(events: ReadonlyArray<{ role: string; content?: unknown }>): ConvLine[] {
  const out: ConvLine[] = [];
  for (const e of events) {
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    const text = typeof e.content === 'string' ? e.content.trim() : '';
    if (!text) continue;
    out.push({ role: e.role === 'user' ? 'USER' : 'ASSISTANT', text: text.length > MESSAGE_CAP ? `${text.slice(0, MESSAGE_CAP)} … [cut]` : text });
  }
  return out;
}

export async function conversationOf(s: FoundSession): Promise<ConvLine[]> {
  if (s.kind === 'devin') return devinLines(readDevinTranscript(s.sessionId, { limit: 5000 })?.events ?? []);
  const msgs = await getSessionMessages(s.sessionId, { dir: s.project.path });
  return msgs.map(messageText).filter((l): l is ConvLine => l !== null);
}

const fmt = (l: ConvLine, i: number) => `#${i + 1} ${l.role}: ${l.text}`;

// Pure: what read_session answers. Messages are numbered from 1 so a later
// call can ask for others. With no `start`: the first message (what the
// session was asked to do) and as many of the latest as fit. With `start`:
// `count` messages from there, as many as fit.
export function renderConversation(
  s: Pick<FoundSession, 'kind' | 'sessionId' | 'title'>,
  lines: readonly ConvLine[],
  opts: { start?: number; count?: number } = {},
  budget = READ_BUDGET,
): string {
  const head = `Session "${s.title}" (${s.kind === 'claude' ? 'Claude' : 'Devin'}, id ${s.sessionId}): ${lines.length} message${lines.length === 1 ? '' : 's'} (tool calls and their output are not included).`;
  if (lines.length === 0) return `${head}\nNothing has been said in it yet.`;
  if (opts.start != null) {
    const from = Math.min(Math.max(1, Math.floor(opts.start)), lines.length);
    const want = Math.max(1, Math.floor(opts.count ?? DEFAULT_COUNT));
    const shown: string[] = [];
    let used = 0;
    for (let i = from - 1; i < lines.length && shown.length < want; i++) {
      const t = fmt(lines[i], i);
      if (used + t.length > budget && shown.length > 0) break;
      shown.push(t);
      used += t.length;
    }
    const to = from + shown.length - 1;
    const more = to < lines.length ? ` More follow: call again with start=${to + 1}.` : ' That is the end of it.';
    return `${head}\nMessages ${from} to ${to}.${more}\n\n${shown.join('\n\n')}`;
  }
  const first = fmt(lines[0], 0);
  const tail: string[] = [];
  let used = first.length;
  let from = lines.length;
  for (let i = lines.length - 1; i >= 1; i--) {
    const t = fmt(lines[i], i);
    if (used + t.length > budget && tail.length > 0) break;
    tail.unshift(t);
    used += t.length;
    from = i;
  }
  const omitted = from - 1;
  const note = omitted > 0
    ? `Message 1, then the latest ${tail.length}: messages 2 to ${from} are left out — call again with start (and count) to read them.`
    : 'All of it.';
  return `${head}\n${note}\n\n${[first, ...(omitted > 0 ? [`[… ${omitted} message${omitted === 1 ? '' : 's'} left out …]`] : []), ...tail].join('\n\n')}`;
}

// What the read_session tool does, as text for Claude.
export async function readSessionFor(uid: string, sessionId: string, opts: { start?: number; count?: number } = {}): Promise<{ text: string; isError: boolean }> {
  const s = await findUserSession(uid, sessionId.trim());
  if (!s) return { text: `No session with id ${sessionId} in this user's projects. Use the id exactly as it is written in the mention.`, isError: true };
  try { return { text: renderConversation(s, await conversationOf(s), opts), isError: false }; }
  catch (e) { return { text: `Could not read session ${sessionId}: ${String((e as Error).message ?? e)}`, isError: true }; }
}
