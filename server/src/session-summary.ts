import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import { getSessionInfo, getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk';
import { getUserId } from './auth.js';
import { getProject } from './store.js';

// Model: server.SummarizeSession — a short brief of a Claude session, written
// for a new session that has not seen it (web.NewChildSession: "Includes
// context from parent"). Made by a small model reading the transcript: the
// parent session itself is not touched, and need not be running.

export const SUMMARY_MODEL = 'haiku';
// How much of the conversation the summarizer reads: the opening request in
// full (capped), then as much of the end as fits.
export const DIGEST_HEAD_CHARS = 6_000;
export const DIGEST_TAIL_CHARS = 90_000;
const MESSAGE_CAP = 4_000;
// A session that was compacted opens with claude's own summary of everything
// before: the best account there is of the earlier work, so it is read whole
// (up to this) rather than cut like an ordinary first message.
export const COMPACT_SUMMARY_CHARS = 60_000;
const COMPACT_SUMMARY_RE = /^This session is being continued from a previous conversation/;

export const SUMMARY_INSTRUCTIONS = [
  'Below is a conversation between a user and a coding assistant. Write a brief for a new assistant session that has not seen it and will help with follow-up work.',
  'Cover: the goal; decisions made and why; constraints and preferences the user stated; the current state (done, in progress, open); the files, branches, pull requests and commands that matter.',
  'Be specific and keep names, paths and numbers exact. Leave out greetings and the back-and-forth. At most about 350 words.',
  'Use only what the conversation says: do not describe your own environment, working directory or tools, and do not guess at things it leaves open.',
  'Write in the language the user mostly wrote in. Output only the brief, with no preamble.',
].join(' ');

type Line = { role: 'USER' | 'ASSISTANT'; text: string };

// Pure: the readable text of one transcript message — what was said, not the
// tool traffic.
export function messageText(m: { type?: string; message?: any }): Line | null {
  if (m?.type !== 'user' && m?.type !== 'assistant') return null;
  const c = m.message?.content;
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '').trim();
  if (!text) return null;
  const cap = m.type === 'user' && COMPACT_SUMMARY_RE.test(text) ? COMPACT_SUMMARY_CHARS : MESSAGE_CAP;
  return { role: m.type === 'user' ? 'USER' : 'ASSISTANT', text: text.length > cap ? `${text.slice(0, cap)} … [cut]` : text };
}

// Pure: the conversation as text within a budget — the first request, a note
// of what was left out, then the most recent messages.
export function transcriptDigest(msgs: readonly { type?: string; message?: any }[], head = DIGEST_HEAD_CHARS, tail = DIGEST_TAIL_CHARS): string {
  const lines = msgs.map(messageText).filter((l): l is Line => l !== null);
  const fmt = (l: Line) => `${l.role}: ${l.text}`;
  if (lines.length === 0) return '';
  const compacted = lines[0].role === 'USER' && COMPACT_SUMMARY_RE.test(lines[0].text);
  const first = compacted ? `SUMMARY OF THE EARLIER CONVERSATION (written when it was compacted):\n${lines[0].text}` : fmt(lines[0]).slice(0, head);
  const rest = lines.slice(1);
  const kept: string[] = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const s = fmt(rest[i]);
    if (used + s.length > tail && kept.length > 0) break;
    kept.unshift(s);
    used += s.length;
    if (used > tail) break;
  }
  const omitted = rest.length - kept.length;
  return [first, ...(omitted > 0 ? [`[… ${omitted} earlier message${omitted === 1 ? '' : 's'} left out …]`] : []), ...kept].join('\n\n');
}

// One summary per (session, length of its transcript), for a while: opening
// two children in a row, or reloading the tab, doesn't pay twice.
const cache = new Map<string, { at: number; summary: string }>();
const CACHE_MS = 10 * 60_000;
const inflight = new Map<string, Promise<string>>();

async function runSummarizer(digest: string): Promise<string> {
  const q = query({
    prompt: `${SUMMARY_INSTRUCTIONS}\n\n<conversation>\n${digest}\n</conversation>`,
    options: {
      model: SUMMARY_MODEL,
      // Not Claude Code's own prompt: no environment block to leak into the brief.
      systemPrompt: 'You write short, exact briefs of conversations. You have no tools and no project: everything you know is in the conversation you are given.',
      cwd: os.tmpdir(),
      settingSources: [],
      persistSession: false,
      tools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
    },
  });
  const timer = setTimeout(() => { try { q.close(); } catch {} }, 90_000);
  try {
    for await (const m of q as AsyncIterable<any>) {
      if (m?.type === 'result') {
        if (m.subtype === 'success' && typeof m.result === 'string' && m.result.trim()) return m.result.trim();
        throw new Error(`summarizer ended with ${m.subtype ?? 'no result'}`);
      }
    }
    throw new Error('summarizer gave no result');
  } finally {
    clearTimeout(timer);
    try { q.close(); } catch {}
  }
}

export async function summarizeSession(projectPath: string, sessionId: string): Promise<{ summary: string; title: string }> {
  const msgs = await getSessionMessages(sessionId, { dir: projectPath });
  let title = sessionId.slice(0, 8);
  try { title = (await getSessionInfo(sessionId, { dir: projectPath }))?.summary?.trim() || title; } catch {}
  const digest = transcriptDigest(msgs);
  if (!digest) throw Object.assign(new Error('the parent session has no conversation yet'), { code: 409 });
  const key = `${sessionId}:${msgs.length}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { summary: hit.summary, title };
  let p = inflight.get(key);
  if (!p) {
    p = runSummarizer(digest).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const summary = await p;
  cache.set(key, { at: Date.now(), summary });
  return { summary, title };
}

export function registerSessionSummaryRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string; sid: string } }>('/api/projects/:id/sdk-sessions/:sid/summary', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(req.params.sid)) return reply.code(400).send({ error: 'bad session id' });
    try { return await summarizeSession(project.path, req.params.sid); }
    catch (e: any) { return reply.code(typeof e?.code === 'number' ? e.code : 502).send({ error: String(e?.message ?? e) }); }
  });
}
