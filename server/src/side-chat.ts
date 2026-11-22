import { query, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { getUserId } from './auth.js';
import { duplexRoute } from './duplex.js';
import { makeInputQueue, sdkEnv, sdkLiveModel } from './sdk-session.js';
import { getProject } from './store.js';
import { sessionCwd } from './worktrees.js';

// Model: SideChat (/btw) — ask about a Claude session without interrupting
// it. The side chat is a fork of the session's conversation as it stands
// (resume + forkSession) that is never written to disk (persistSession:
// false): it knows everything the session knows, the session itself goes on
// untouched, and nothing shows in the Sessions list. Read-only: it may read
// and search files, nothing that needs leave (edits, shell commands) is
// allowed. It lives as long as its side panel tab is connected.

// Tools that need no leave in "default" mode (Read, Glob, Grep, …) run; any
// that would ask is refused with this.
export const READ_ONLY_DENIAL = 'This is a side chat (/btw): it can read and search files but not change anything or run commands. Answer from the conversation and what you can read; say what the user would have to do in the main session.';

// Pure: what the side chat's model is sent for one question.
export function sideQuestion(text: string, first: boolean): string {
  const head = first
    ? '[Side question (/btw). The task above is still being carried on separately, in the main session — do not continue or redo it here. Answer only this question, briefly, from the conversation so far and by reading files if needed. You cannot change anything.]'
    : '[Side question, continued.]';
  return `${head}\n\n${text}`;
}

const denyAll: CanUseTool = async () => ({ behavior: 'deny', message: READ_ONLY_DENIAL });

function out(socket: WebSocket, msg: unknown) { try { socket.send(JSON.stringify(msg)); } catch {} }

// Pure: one SDK message → what the side chat panel needs (null: nothing).
export function sideEvent(m: any): Record<string, unknown> | null {
  if (m?.type === 'system' && m.subtype === 'init') return { type: 'ready', model: m.model ?? null };
  if (m?.type === 'stream_event') {
    const e = m.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !m.parent_tool_use_id) return { type: 'delta', text: String(e.delta.text ?? '') };
    return null;
  }
  if (m?.type === 'assistant' && !m.parent_tool_use_id) {
    const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
    const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
    const tools = blocks.filter((b: any) => b?.type === 'tool_use').map((b: any) => {
      const i = b.input ?? {};
      const what = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.query ?? i.url ?? '';
      return `${b.name}${what ? ` ${String(what).slice(0, 120)}` : ''}`;
    });
    return { type: 'assistant', text, tools };
  }
  if (m?.type === 'result') {
    return { type: 'done', ok: m.subtype === 'success', costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null, error: m.subtype === 'success' ? null : String(m.subtype ?? 'error') };
  }
  return null;
}

export function registerSideChatRoutes(app: FastifyInstance) {
  duplexRoute<{ project?: string; session?: string }>(app, '/ws/side-chat', async (socket, req) => {
    // Listen before the first await: a client sends its first question as
    // soon as the socket is open, and a message with no listener is lost.
    const early: any[] = [];
    let handle: ((msg: any) => void) | null = null;
    let closed = false;
    let onClose: (() => void) | null = null;
    socket.on('message', (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'ping') { out(socket, { type: 'pong' }); return; }
      if (handle) handle(msg); else early.push(msg);
    });
    socket.on('close', () => { closed = true; onClose?.(); });
    const uid = getUserId(req);
    if (!uid) { out(socket, { type: 'error', message: 'unauthorized' }); socket.close(); return; }
    const project = req.query.project ? await getProject(uid, req.query.project) : null;
    const sessionId = String(req.query.session ?? '');
    if (!project || !/^[0-9a-f-]{8,64}$/i.test(sessionId)) { out(socket, { type: 'error', message: 'No such session' }); socket.close(); return; }
    const cwd = await sessionCwd(project.path, sessionId);
    if (closed) return;
    const input = makeInputQueue();
    let asked = 0;
    const q = query({
      prompt: input.iterable(),
      options: {
        cwd,
        resume: sessionId,
        forkSession: true,
        persistSession: false,
        model: sdkLiveModel(sessionId) ?? undefined,
        includePartialMessages: true,
        permissionMode: 'default',
        canUseTool: denyAll,
        env: sdkEnv(false, false),
        pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
      },
    });
    out(socket, { type: 'started' });
    void (async () => {
      try {
        for await (const m of q) {
          if (closed) break;
          const e = sideEvent(m);
          if (e) out(socket, e);
        }
      } catch (e) {
        if (!closed) out(socket, { type: 'error', message: String((e as Error).message ?? e) });
      }
      if (!closed) { out(socket, { type: 'exit' }); socket.close(); }
    })();

    handle = (msg: any) => {
      if (msg.type === 'ask') {
        const text = String(msg.text ?? '').trim().slice(0, 20_000);
        if (!text) return;
        const um: SDKUserMessage = { type: 'user', uuid: randomUUID() as any, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: sideQuestion(text, asked === 0) }] } };
        asked++;
        input.push(um);
        return;
      }
      if (msg.type === 'stop') { void q.interrupt().catch(() => {}); }
    };
    onClose = () => {
      input.close();
      try { q.close(); } catch {}
    };
    for (const m of early.splice(0)) handle(m);
  });
}
