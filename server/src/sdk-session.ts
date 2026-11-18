// Model: server.ClaudeSdkSessionBridge / ListSdkSessions / ReadSdkTranscript /
// RenameSession (package "Claude SDK Session"). The second Claude bridge: the
// same jsonl sessions as session.ts, but driven through the official Agent
// SDK instead of a hand-rolled stream-json subprocess. Deliberately shares no
// code with session.ts — projects/claude-sdk-session/design.md.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  type Query,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
  type SlashCommand,
  type ModelInfo,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mapContextUsage, type ContextSnapshot } from './context-usage.js';
import {
  CHILD_TOOLS_INSTRUCTIONS, childIdsOf, childReport, cleanChildTitle, sessionDepth, spawnRefusal,
} from './child-sessions.js';
import { getProject, getSessionMeta, getSettings, putSessionMeta, setParent, type Settings } from './store.js';
import { getUserId } from './auth.js';
import { runBang, bangContextBlocks, type BangResult, type RunningBang } from './shell-exec.js';
import { publishSessionEvent, type SessionOwner } from './notify.js';
import { isEffortLevel } from './models.js';
import { markLive, unmarkLive, liveBridge, type LiveState } from './live-sessions.js';
import { registerWireSession, wireBaseUrl } from './observe/wire-proxy.js';
import { encodeCwd } from './observe/transcript.js';

// ----- input queue: one always-open async iterable per live query ---------

type InputQueue = {
  iterable: () => AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  close: () => void;
};

function makeInputQueue(): InputQueue {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* iterable() {
    while (!closed) {
      if (buf.length) {
        yield buf.shift()!;
        continue;
      }
      await new Promise<void>((r) => { wake = r; });
    }
  }
  return {
    iterable,
    push(m) { buf.push(m); const w = wake; wake = null; w?.(); },
    close() { closed = true; const w = wake; wake = null; w?.(); },
  };
}

// ----- entry ---------------------------------------------------------------

type PendingAsk = {
  input: Record<string, unknown>;
  toolUseID: string;
  resolve: (r: PermissionResult) => void;
  // Counts down only while no client is attached (rule: same as session.ts).
  timer: NodeJS.Timeout | null;
};

// Model: Claude Session.tasks — one subagent / background task of the live
// query, as the SDK's task_started / task_progress / task_updated /
// task_notification events describe it.
export type SdkTask = {
  taskId: string;
  toolUseId: string | null;
  description: string;
  subagentType: string | null;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  background: boolean;
  totalTokens: number | null;
  toolUses: number | null;
  lastTool: string | null;
};

// Pure: fold one SDK system message into the task table. Returns true when
// it was a task event.
export function applyTaskEvent(tasks: Map<string, SdkTask>, m: any): boolean {
  if (m?.type !== 'system' || typeof m.task_id !== 'string' || !m.task_id) return false;
  const id: string = m.task_id;
  const cur = tasks.get(id);
  const usage = (t: SdkTask) => {
    if (typeof m.usage?.total_tokens === 'number') t.totalTokens = m.usage.total_tokens;
    if (typeof m.usage?.tool_uses === 'number') t.toolUses = m.usage.tool_uses;
  };
  if (m.subtype === 'task_started') {
    tasks.set(id, {
      taskId: id,
      toolUseId: typeof m.tool_use_id === 'string' ? m.tool_use_id : cur?.toolUseId ?? null,
      description: typeof m.description === 'string' ? m.description : cur?.description ?? '',
      subagentType: typeof m.subagent_type === 'string' ? m.subagent_type : cur?.subagentType ?? null,
      status: 'running',
      background: m.is_backgrounded === true,
      totalTokens: cur?.totalTokens ?? null,
      toolUses: cur?.toolUses ?? null,
      lastTool: cur?.lastTool ?? null,
    });
    return true;
  }
  if (!cur) return m.subtype === 'task_progress' || m.subtype === 'task_updated' || m.subtype === 'task_notification';
  if (m.subtype === 'task_progress') {
    usage(cur);
    if (typeof m.last_tool_name === 'string') cur.lastTool = m.last_tool_name;
    if (typeof m.description === 'string' && m.description) cur.description = m.description;
    return true;
  }
  if (m.subtype === 'task_updated') {
    const st = m.patch?.status;
    if (st === 'completed' || st === 'failed') cur.status = st;
    else if (st === 'killed') cur.status = 'stopped';
    else if (st === 'running' || st === 'pending' || st === 'paused') cur.status = 'running';
    if (typeof m.patch?.is_backgrounded === 'boolean') cur.background = m.patch.is_backgrounded;
    return true;
  }
  if (m.subtype === 'task_notification') {
    if (m.status === 'completed' || m.status === 'failed' || m.status === 'stopped') cur.status = m.status;
    usage(cur);
    return true;
  }
  return false;
}

type SdkEntry = {
  cwd: string;
  // Model: server.SessionEvents — who to tell when a turn ends or the agent
  // starts waiting on the user.
  owner: SessionOwner;
  sessionId: string | null; // claude's session_id (null until system.init)
  q: Query | null;
  queue: InputQueue;
  // Bumped on every re-create (effort change, rewind, kill) so the pump of
  // a replaced query ignores its tail.
  generation: number;
  clients: Set<WebSocket>;
  thinking: boolean;
  model: string | null;
  requestedModel: string;
  effort: string;
  // Model: Claude Session.observeWire — route this session's API calls
  // through the built-in wire proxy (env ANTHROPIC_BASE_URL). Carried over on
  // every re-create (effort change, rewind).
  observeWire: boolean;
  title: string | null;
  // Last /context-style reading of the window (null until the first one).
  context: ContextSnapshot | null;
  // Background tasks and subagents of the live query, by task id (SDK
  // task_* events). Kept after they end so the Sessions tree can show how.
  tasks: Map<string, SdkTask>;
  // Model: Session.parent — set on the handshake of a "New child session";
  // written to SessionMeta once claude names the session (system.init).
  parentSessionId: string | null;
  // Model: Session.children — this session's agent may open child sessions
  // (Settings.childSessionTools).
  childTools: boolean;
  // The turn now running was asked for by the parent agent (spawn / send):
  // its answer goes back to the parent when it ends.
  reportToParent: boolean;
  commands: SlashCommand[];
  agents: string[];
  models: ModelInfo[];
  pendingAsks: Map<string, PendingAsk>;
  killTimer?: NodeJS.Timeout;
  titleTimers: NodeJS.Timeout[];
  // External-change detection (rule-406): any SDK message or user input is
  // "our" activity; a jsonl write outside the quiet window is someone else's.
  lastActivity: number;
  externalNotified: boolean;
  watcher?: nodeFs.FSWatcher;
  externalTimer?: NodeJS.Timeout;
  // Model: server.RunBangCommand. Finished `!` commands not yet seen by the
  // model — prepended to the next prompt (Claude Code bash-mode semantics:
  // the output joins the conversation but doesn't start a turn by itself).
  pendingBang: Array<{ id: string; result: BangResult }>;
  runningBang: Map<string, { command: string; run: RunningBang }>;
};

const byId = new Map<string, SdkEntry>();
// Fresh sessions between query() and system.init.
const pending = new Set<SdkEntry>();

const CLIENT_DRAIN_GRACE_MS = 5 * 60_000;
const ASK_IDLE_TIMEOUT_MS = 5 * 60_000;
const PING_INTERVAL_MS = 30_000;
const EXTERNAL_QUIET_MS = 30_000;

function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

function startWatcher(entry: SdkEntry) {
  if (entry.watcher || !entry.sessionId) return;
  const file = jsonlPathFor(entry.cwd, entry.sessionId);
  try {
    entry.watcher = nodeFs.watch(file, () => {
      if (Date.now() - entry.lastActivity < EXTERNAL_QUIET_MS) return;
      if (entry.externalNotified) return;
      if (entry.externalTimer) clearTimeout(entry.externalTimer);
      entry.externalTimer = setTimeout(() => {
        if (entry.externalNotified) return;
        entry.externalNotified = true;
        broadcast(entry, { type: 'external_change', sessionId: entry.sessionId });
      }, 400);
    });
  } catch {
    setTimeout(() => { if (!entry.watcher && entry.q) startWatcher(entry); }, 1000);
  }
}

function stopWatcher(entry: SdkEntry) {
  if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = undefined; }
  if (entry.externalTimer) { clearTimeout(entry.externalTimer); entry.externalTimer = undefined; }
}

function touchActivity(entry: SdkEntry) {
  entry.lastActivity = Date.now();
  entry.externalNotified = false;
}

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

function broadcast(entry: SdkEntry, msg: unknown, except?: WebSocket) {
  const raw = JSON.stringify(msg);
  for (const c of entry.clients) {
    if (c === except) continue;
    try { c.send(raw); } catch {}
  }
}

function sdkEnv(observeWire: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  // Same as session.ts: non-interactive runs only checkpoint files with this set.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';
  // Model: server.ObserveWireSession — the SDK runs the same claude binary,
  // which honours ANTHROPIC_BASE_URL like the cli bridge's spawn does.
  const wire = observeWire ? wireBaseUrl() : null;
  if (wire) env.ANTHROPIC_BASE_URL = wire;
  return env;
}

function makeCanUseTool(entry: SdkEntry): CanUseTool {
  return async (toolName, input, opts) => {
    // bypassPermissions already auto-allows everything else; the SDK still
    // consults us for AskUserQuestion because it needs a human.
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const id = opts.requestId;
    return new Promise<PermissionResult>((resolve) => {
      const ask: PendingAsk = { input, toolUseID: opts.toolUseID, resolve, timer: null };
      entry.pendingAsks.set(id, ask);
      if (entry.clients.size === 0) armAsk(entry, id);
      opts.signal.addEventListener('abort', () => {
        if (entry.pendingAsks.delete(id)) {
          if (ask.timer) clearTimeout(ask.timer);
          broadcast(entry, { type: 'ask_cancel', id });
          resolve({ behavior: 'deny', message: 'Interrupted' });
        }
      });
      broadcast(entry, { type: 'ask', data: askEvent(id, ask) });
      publishSessionEvent(entry.owner, 'awaiting', entry.sessionId, entry.title);
    });
  };
}

// Shaped like the CLI's control_request so the web side can parse both
// bridges with the same lib/elicitation.parseAskUserQuestion.
function askEvent(id: string, ask: PendingAsk) {
  return {
    type: 'control_request',
    request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ask.input, tool_use_id: ask.toolUseID },
  };
}

function armAsk(entry: SdkEntry, id: string) {
  const ask = entry.pendingAsks.get(id);
  if (!ask || ask.timer) return;
  ask.timer = setTimeout(() => {
    if (!entry.pendingAsks.delete(id)) return;
    ask.resolve({ behavior: 'deny', message: 'No one answered the question in time. Stop and wait for the next user message.' });
    broadcast(entry, { type: 'ask_timeout', id });
  }, ASK_IDLE_TIMEOUT_MS);
}

function armAllAsks(entry: SdkEntry) { for (const id of entry.pendingAsks.keys()) armAsk(entry, id); }
function disarmAllAsks(entry: SdkEntry) {
  for (const a of entry.pendingAsks.values()) { if (a.timer) { clearTimeout(a.timer); a.timer = null; } }
}
function denyAllAsks(entry: SdkEntry, message: string) {
  for (const [id, a] of entry.pendingAsks) {
    if (a.timer) clearTimeout(a.timer);
    a.resolve({ behavior: 'deny', message });
    entry.pendingAsks.delete(id);
  }
}

// ----- query lifecycle -----------------------------------------------------

function startQuery(entry: SdkEntry, opts: { resume?: string; resumeSessionAt?: string }) {
  entry.generation++;
  const gen = entry.generation;
  entry.queue = makeInputQueue();
  // Tasks die with the process that ran them.
  for (const t of entry.tasks.values()) if (t.status === 'running') t.status = 'stopped';
  const q = query({
    prompt: entry.queue.iterable(),
    options: {
      cwd: entry.cwd,
      model: entry.requestedModel || undefined,
      effort: isEffortLevel(entry.effort) ? entry.effort : undefined,
      resume: opts.resume,
      resumeSessionAt: opts.resumeSessionAt,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      enableFileCheckpointing: true,
      env: sdkEnv(entry.observeWire),
      pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
      stderr: (data) => broadcast(entry, { type: 'stderr', data }),
      canUseTool: makeCanUseTool(entry),
      mcpServers: entry.childTools ? { aie: childToolsServer(entry) } : undefined,
    },
  });
  entry.q = q;
  void q.initializationResult().then((init) => {
    if (gen !== entry.generation) return;
    entry.commands = init.commands ?? [];
    entry.agents = (init.agents ?? []).map((a: any) => String(a?.name ?? '')).filter(Boolean);
    entry.models = init.models ?? [];
    broadcast(entry, { type: 'catalog', ...catalogOf(entry) });
    refreshContext(entry);
    // system.init — where the model normally comes from — only arrives with
    // the first turn. Until then the status bar had no model to show (and so
    // no way to switch it): work it out from the catalog now.
    if (!entry.model) {
      const initial = resolveInitialModel(entry.models, entry.requestedModel);
      if (initial) {
        entry.model = initial;
        broadcast(entry, { type: 'model', model: initial });
      }
    }
  }).catch(() => {});
  void pump(entry, q, gen);
}

// Model: server.ClaudeSdkSessionBridge — the model a fresh query will run,
// before it has run anything: the catalog entry for what was asked for (or
// for "default" when nothing was), resolved to a concrete model id. Null when
// the catalog can't say.
export function resolveInitialModel(
  models: ReadonlyArray<{ value: string; resolvedModel?: string }>,
  requested: string,
): string | null {
  const want = requested.trim();
  const hit = models.find((m) => m.value === (want || 'default'));
  if (hit) return hit.resolvedModel || (want ? hit.value : null);
  return want || null;
}

async function pump(entry: SdkEntry, q: Query, gen: number) {
  try {
    for await (const m of q) {
      if (gen !== entry.generation) return;
      onSdkMessage(entry, m as any);
    }
  } catch (e) {
    if (gen !== entry.generation) return;
    broadcast(entry, { type: 'error', message: String(e) });
  }
  if (gen !== entry.generation) return;
  // Streaming input never ends on its own — reaching here means the process
  // died under us.
  broadcast(entry, { type: 'exit' });
  teardown(entry);
}

// Record the session's place in the tree under its new id: the parent named
// on the handshake, or — when claude re-ids a session (a rewind forks it) —
// the parent its previous id had.
async function linkToParent(entry: SdkEntry, oldId: string | null, newId: string) {
  try {
    const meta = await getSessionMeta(entry.owner.uid);
    const parent = entry.parentSessionId ?? (oldId ? meta.parents[`claude:${oldId}`] : undefined);
    if (!parent || parent === newId) return;
    const next = setParent(meta, `claude:${newId}`, parent);
    if (next !== meta) await putSessionMeta(entry.owner.uid, next);
  } catch {}
}

function onSdkMessage(entry: SdkEntry, m: any) {
  touchActivity(entry);
  applyTaskEvent(entry.tasks, m);
  if (m?.type === 'system' && m?.subtype === 'init') {
    const sid: string | undefined = m.session_id;
    if (sid && entry.sessionId !== sid) {
      void linkToParent(entry, entry.sessionId, sid);
      if (entry.sessionId) { byId.delete(entry.sessionId); unmarkLive(entry.sessionId, 'sdk'); }
      entry.sessionId = sid;
      byId.set(sid, entry);
      markLive(sid, 'sdk');
      pending.delete(entry);
      if (entry.observeWire) registerWireSession(sid, entry.cwd);
      stopWatcher(entry);
      startWatcher(entry);
    }
    if (typeof m.model === 'string') entry.model = m.model;
  }
  if (m?.type === 'result') {
    entry.thinking = false;
    if (entry.reportToParent) { entry.reportToParent = false; void reportToParent(entry, m); }
    refreshContext(entry);
    scheduleTitleRefresh(entry);
    if (entry.clients.size === 0) scheduleKillIfIdle(entry);
    if (entry.pendingAsks.size === 0) publishSessionEvent(entry.owner, 'done', entry.sessionId, entry.title);
  }
  broadcast(entry, { type: 'message', data: m });
}

// Re-read the context window and push it to every client. Summary detail
// answers locally (no model / token-count calls); a reply from a replaced
// query is dropped.
function refreshContext(entry: SdkEntry) {
  const q = entry.q;
  if (!q) return;
  const gen = entry.generation;
  q.getContextUsage({ detail: 'summary' }).then((r) => {
    if (gen !== entry.generation) return;
    const context = mapContextUsage(r);
    if (!context) return;
    entry.context = context;
    broadcast(entry, { type: 'context', context });
  }).catch(() => {});
}

function catalogOf(entry: SdkEntry) {
  return {
    commands: entry.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
    agents: entry.agents,
    models: entry.models.map((mm) => ({ value: mm.value, displayName: mm.displayName, description: mm.description })),
  };
}

// AI title (SDKSessionInfo.summary) lands a few seconds after the first
// result; re-check twice. Manual renames come through the same field.
function scheduleTitleRefresh(entry: SdkEntry) {
  for (const t of entry.titleTimers) clearTimeout(t);
  entry.titleTimers = [2500, 8000].map((ms) => setTimeout(() => void refreshTitle(entry), ms));
}

async function refreshTitle(entry: SdkEntry) {
  if (!entry.sessionId) return;
  try {
    const info = await getSessionInfo(entry.sessionId, { dir: entry.cwd });
    const t = info?.summary?.trim();
    if (t && t !== entry.title) {
      entry.title = t;
      broadcast(entry, { type: 'title', title: t });
    }
  } catch {}
}

function scheduleKillIfIdle(entry: SdkEntry) {
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined;
    if (entry.clients.size > 0) return;
    if (entry.thinking || entry.pendingAsks.size > 0) { scheduleKillIfIdle(entry); return; }
    destroy(entry);
  }, CLIENT_DRAIN_GRACE_MS);
}

function teardown(entry: SdkEntry) {
  stopWatcher(entry);
  for (const r of entry.runningBang.values()) r.run.interrupt();
  denyAllAsks(entry, 'Session ended');
  for (const t of entry.titleTimers) clearTimeout(t);
  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
  if (entry.sessionId) { byId.delete(entry.sessionId); unmarkLive(entry.sessionId, 'sdk'); }
  pending.delete(entry);
  for (const c of entry.clients) { try { c.close(); } catch {} }
  entry.clients.clear();
}

function destroy(entry: SdkEntry) {
  entry.generation++;
  try { entry.q?.close(); } catch {}
  entry.queue.close();
  entry.q = null;
  teardown(entry);
}

function userMessage(uuid: string, text: string, images: Array<{ mediaType?: string; data?: string }> | undefined, bang: BangResult[] = []): SDKUserMessage {
  const content: any[] = [];
  for (const r of bang) for (const t of bangContextBlocks(r)) content.push({ type: 'text', text: t });
  if (text) content.push({ type: 'text', text });
  for (const img of images ?? []) {
    if (!img?.mediaType || !img?.data) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  return { type: 'user', uuid: uuid as any, message: { role: 'user', content }, parent_tool_use_id: null };
}

// Poll until the CLI has persisted the user record with this uuid (so a
// client refetch after `rewound` sees the new prompt).
async function waitForUserRecord(entry: SdkEntry, uuid: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.sessionId) {
      try {
        const msgs = await getSessionMessages(entry.sessionId, { dir: entry.cwd });
        if (msgs.some((m) => m.uuid === uuid)) return;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ----- WS client handling --------------------------------------------------

function attachClient(entry: SdkEntry, socket: WebSocket) {
  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
  entry.clients.add(socket);
  disarmAllAsks(entry);

  let alive = true;
  const pingTimer = setInterval(() => {
    if (!alive) { try { socket.terminate(); } catch {} return; }
    alive = false;
    try { socket.ping(); } catch {}
  }, PING_INTERVAL_MS);
  socket.on('pong', () => { alive = true; });

  socket.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { send(socket, { type: 'error', message: 'invalid json' }); return; }
    void handleClientMessage(entry, socket, msg);
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    entry.clients.delete(socket);
    if (entry.clients.size === 0) {
      armAllAsks(entry);
      scheduleKillIfIdle(entry);
    }
  });
}

async function handleClientMessage(entry: SdkEntry, socket: WebSocket, msg: any) {
  if (msg.type === 'ping') { send(socket, { type: 'pong' }); return; }
  if (msg.type === 'bang') { handleBang(entry, msg); return; }
  if (msg.type === 'bang_interrupt') { entry.runningBang.get(String(msg.id ?? ''))?.run.interrupt(); return; }
  if (!entry.q) { send(socket, { type: 'error', message: 'session is not live' }); return; }

  if (msg.type === 'user') {
    const text = String(msg.text ?? '');
    const images = Array.isArray(msg.images) ? msg.images : [];
    if (!text && images.length === 0) return;
    const uuid = randomUUID();
    const bang = entry.pendingBang.splice(0).map((b) => b.result);
    const um = userMessage(uuid, text, images, bang);
    entry.thinking = true;
    touchActivity(entry);
    // The SDK does not echo our own prompts back; every client (sender
    // included) learns the uuid from this frame.
    broadcast(entry, { type: 'user_echo', msgId: typeof msg.msgId === 'string' ? msg.msgId : null, uuid, message: um.message });
    entry.queue.push(um);
    return;
  }
  if (msg.type === 'stop') {
    for (const r of entry.runningBang.values()) r.run.interrupt();
    try { await entry.q.interrupt(); } catch (e) { send(socket, { type: 'error', message: `interrupt failed: ${String(e)}` }); }
    return;
  }
  if (msg.type === 'set_model') {
    const model = String(msg.model ?? '').trim();
    if (!model) return;
    try {
      await entry.q.setModel(model);
      entry.model = model;
      entry.requestedModel = model;
      broadcast(entry, { type: 'model', model });
      refreshContext(entry); // the window size follows the model
    } catch (e) {
      send(socket, { type: 'error', message: `set_model failed: ${String(e)}` });
    }
    return;
  }
  if (msg.type === 'set_effort') {
    // No setEffort in the SDK control protocol: re-create the query on the
    // same session (same approach as session.ts' respawn).
    const effort = String(msg.effort ?? '').trim();
    if (effort && !isEffortLevel(effort)) { send(socket, { type: 'effort_error', message: `invalid effort level: ${effort}` }); return; }
    if (entry.thinking) { send(socket, { type: 'effort_error', message: 'wait for the current turn to finish before changing effort' }); return; }
    if (!entry.sessionId) { send(socket, { type: 'effort_error', message: 'session not initialized yet — send a message first' }); return; }
    replaceQuery(entry, { resume: entry.sessionId });
    entry.effort = effort;
    // effort is read by startQuery, so set it before the re-create.
    broadcast(entry, { type: 'effort', effort });
    return;
  }
  if (msg.type === 'elicitation_response') {
    const id = String(msg.id ?? '');
    const ask = entry.pendingAsks.get(id);
    if (!ask) return;
    entry.pendingAsks.delete(id);
    if (ask.timer) clearTimeout(ask.timer);
    if (msg.action === 'accept' && msg.content && typeof msg.content === 'object') {
      ask.resolve({ behavior: 'allow', updatedInput: { ...ask.input, answers: msg.content } });
    } else {
      ask.resolve({ behavior: 'deny', message: 'The user chose to reply in chat instead of answering the form. Stop and wait for their next message.' });
    }
    broadcast(entry, { type: 'ask_done', id });
    return;
  }
  if (msg.type === 'rewind') {
    await handleRewind(entry, socket, msg);
    return;
  }
}

// Model: server.RunBangCommand. Every attached client sees the command start
// and finish (bang_start / bang_result, keyed by the client's id).
function handleBang(entry: SdkEntry, msg: any) {
  const command = String(msg.command ?? '').trim();
  const id = typeof msg.id === 'string' && msg.id ? msg.id.slice(0, 64) : randomUUID();
  if (!command || entry.runningBang.has(id)) return;
  touchActivity(entry);
  const running = runBang(command, entry.cwd);
  entry.runningBang.set(id, { command, run: running });
  broadcast(entry, { type: 'bang_start', id, command });
  void running.promise.then((result) => {
    entry.runningBang.delete(id);
    entry.pendingBang.push({ id, result });
    broadcast(entry, { type: 'bang_result', id, result });
  });
}

// A (re)attaching client rebuilt its view from the jsonl, which doesn't hold
// `!` commands the model hasn't seen yet — hand those over.
function bangStateFrame(entry: SdkEntry) {
  return {
    type: 'bang_state',
    running: [...entry.runningBang].map(([id, r]) => ({ id, command: r.command })),
    pending: entry.pendingBang,
  };
}

// Close the live query and start another on the same entry. Clients stay
// attached; pending asks are denied (their tool call died with the process).
function replaceQuery(entry: SdkEntry, opts: { resume?: string; resumeSessionAt?: string }) {
  stopWatcher(entry);
  denyAllAsks(entry, 'Session restarted');
  const old = entry.q;
  entry.generation++;
  entry.queue.close();
  try { old?.close(); } catch {}
  entry.thinking = false;
  startQuery(entry, opts);
  touchActivity(entry);
  startWatcher(entry);
}

// Model: rewind on the SDK bridge — rewindFiles() for the working tree, then
// resume the same session truncated at the entry before the edited message
// (resumeSessionAt keeps the transcript file; getSessionMessages follows the
// new chain). Editing the first message starts a fresh session instead.
async function handleRewind(entry: SdkEntry, socket: WebSocket, msg: any) {
  const messageUuid = String(msg.messageUuid ?? '').trim();
  const newText = String(msg.newText ?? '').trim();
  const images = Array.isArray(msg.images) ? msg.images : [];
  const fail = (message: string) => send(socket, { type: 'rewind_error', message });
  if (!messageUuid) return fail('messageUuid required');
  if (!newText && images.length === 0) return fail('newText or images required');
  const sid = entry.sessionId;
  const q = entry.q;
  if (!sid || !q) return fail('session not initialized yet');
  if (entry.thinking) return fail('wait for the current turn to finish before rewinding');

  let msgs;
  try { msgs = await getSessionMessages(sid, { dir: entry.cwd }); } catch (e) { return fail(`transcript unavailable: ${String(e)}`); }
  const idx = msgs.findIndex((m) => m.type === 'user' && m.uuid === messageUuid);
  if (idx < 0) return fail('messageUuid not found among user messages');
  const pred = idx > 0 ? msgs[idx - 1].uuid : null;

  try {
    const r = await q.rewindFiles(messageUuid);
    if (r.error) return fail(`file rewind failed: ${r.error}`);
  } catch (e) {
    return fail(`file rewind failed: ${String(e)}`);
  }

  if (pred) {
    replaceQuery(entry, { resume: sid, resumeSessionAt: pred });
  } else {
    byId.delete(sid);
    unmarkLive(sid, 'sdk');
    entry.sessionId = null;
    entry.title = null;
    pending.add(entry);
    replaceQuery(entry, {});
  }
  const uuid = randomUUID();
  const um = userMessage(uuid, newText, images);
  entry.thinking = true;
  entry.queue.push(um);
  await waitForUserRecord(entry, uuid, 8000);
  broadcast(entry, { type: 'rewound', sessionId: entry.sessionId, uuid });
}

function startedFrame(entry: SdkEntry, attached: boolean) {
  return {
    type: 'started',
    sessionId: entry.sessionId,
    resumed: !!entry.sessionId,
    attached,
    clients: entry.clients.size,
    thinking: entry.thinking,
    model: entry.model,
    requestedModel: entry.requestedModel || null,
    effort: entry.effort,
    wire: entry.observeWire,
    title: entry.title,
    context: entry.context,
    ...catalogOf(entry),
  };
}

// Model: server.ListAllSessions / server.StopSession — the Sessions list's
// view of this bridge. Stop ends the process; attached panels get `exit`.
export function sdkLiveState(sessionId: string): LiveState | null {
  const entry = byId.get(sessionId);
  if (!entry) return null;
  return entry.pendingAsks.size > 0 ? 'awaiting' : entry.thinking ? 'running' : 'idle';
}
// Model: Claude Session.tasks, read by server.ListSubagents.
export function sdkTasks(sessionId: string): SdkTask[] {
  return [...(byId.get(sessionId)?.tasks.values() ?? [])];
}
// Model: server.StopSubagent. False when the session isn't the caller's, isn't
// live here, or the task is no longer running.
export async function stopSdkTask(sessionId: string, uid: string, taskId: string): Promise<boolean> {
  const entry = byId.get(sessionId);
  if (!entry || entry.owner.uid !== uid || !entry.q) return false;
  if (entry.tasks.get(taskId)?.status !== 'running') return false;
  try { await entry.q.stopTask(taskId); } catch { return false; }
  return true;
}
export function stopSdkSession(sessionId: string, uid: string): boolean {
  const entry = byId.get(sessionId);
  if (!entry || entry.owner.uid !== uid) return false;
  broadcast(entry, { type: 'exit', code: 'stopped' });
  destroy(entry);
  return true;
}

// A bridge entry with no query yet (startQuery starts one).
function newEntry(o: {
  uid: string; projectId: string; cwd: string; settings: Settings;
  resumeId?: string; parentSessionId?: string | null; observeWire?: boolean; model?: string;
}): SdkEntry {
  return {
    cwd: o.cwd,
    owner: { uid: o.uid, projectId: o.projectId, tabType: 'claude-sdk' },
    sessionId: o.resumeId ?? null,
    q: null,
    queue: makeInputQueue(),
    generation: 0,
    clients: new Set(),
    thinking: false,
    model: null,
    requestedModel: o.model || o.settings.model || '',
    effort: isEffortLevel(o.settings.effort) ? o.settings.effort : '',
    observeWire: o.observeWire === true,
    title: null,
    context: null,
    tasks: new Map(),
    parentSessionId: o.parentSessionId ?? null,
    childTools: o.settings.childSessionTools !== false,
    reportToParent: false,
    commands: [],
    agents: [],
    models: [],
    pendingAsks: new Map(),
    titleTimers: [],
    lastActivity: Date.now(),
    externalNotified: false,
    pendingBang: [],
    runningBang: new Map(),
  };
}

// ----- child sessions driven by the agent (model: Session.children) ---------

// Put a message into a session as if typed, telling every attached client.
function injectUserText(entry: SdkEntry, text: string) {
  const uuid = randomUUID();
  const um = userMessage(uuid, text, []);
  entry.thinking = true;
  touchActivity(entry);
  broadcast(entry, { type: 'user_echo', msgId: null, uuid, message: um.message });
  entry.queue.push(um);
}

// The live entry of one of the caller's sessions, starting its process (a
// resume, no client attached) when it isn't running. Null when the classic
// bridge holds it.
async function wakeSession(from: SdkEntry, sessionId: string): Promise<SdkEntry | null> {
  const live = byId.get(sessionId);
  if (live) return live.owner.uid === from.owner.uid ? live : null;
  if (liveBridge(sessionId) === 'cli') return null;
  const settings = await getSettings(from.owner.uid);
  const entry = newEntry({ uid: from.owner.uid, projectId: from.owner.projectId, cwd: from.cwd, settings, resumeId: sessionId });
  byId.set(sessionId, entry);
  markLive(sessionId, 'sdk');
  try { entry.title = (await getSessionInfo(sessionId, { dir: from.cwd }))?.summary?.trim() || null; } catch {}
  startQuery(entry, { resume: sessionId });
  startWatcher(entry);
  // Nobody is attached: end the process again once it goes quiet.
  scheduleKillIfIdle(entry);
  return entry;
}

// A child finished a turn its parent asked for: hand the answer to the
// parent, waking it if needed.
async function reportToParent(child: SdkEntry, result: any) {
  const parentId = child.parentSessionId ?? (child.sessionId ? (await getSessionMeta(child.owner.uid).catch(() => null))?.parents[`claude:${child.sessionId}`] : undefined);
  if (!parentId || !child.sessionId) return;
  try {
    const parent = await wakeSession(child, parentId);
    if (!parent) return;
    const ok = result?.subtype === 'success' && result?.is_error !== true;
    injectUserText(parent, childReport({
      title: child.title || child.sessionId.slice(0, 8),
      sessionId: child.sessionId,
      ok,
      result: typeof result?.result === 'string' ? result.result : '',
      errorKind: ok ? undefined : String(result?.subtype ?? 'error'),
    }));
  } catch {}
}

const toolText = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });

// The in-process MCP server that gives `parent`'s agent its child-session
// tools. One per query: the handlers close over the entry.
function childToolsServer(parent: SdkEntry) {
  const runningChildren = (parentId: string, ids: string[]) =>
    ids.filter((id) => byId.get(id)?.thinking).length
    + [...pending].filter((e) => e.parentSessionId === parentId && e.thinking).length;

  return createSdkMcpServer({
    name: 'aie',
    version: '1.0.0',
    instructions: CHILD_TOOLS_INSTRUCTIONS,
    tools: [
      tool(
        'spawn_child_session',
        'Open a child session: a separate, full Claude session in this project that works on `prompt` in the background. The user sees it under this session in the Sessions tree and can open it and talk to it. Returns immediately with the child id; the child\'s answer arrives later as a message starting with "[Child session". The child knows nothing of this conversation, so `prompt` must be a complete brief.',
        {
          title: z.string().describe('Short name shown in the Sessions tree, e.g. "Draft Apple Pay tests"'),
          prompt: z.string().describe('The complete task brief for the child: goal, relevant files, constraints, and what to report back'),
          model: z.string().optional().describe('Model for the child (an id or alias this session can use). Omit to use the default.'),
        },
        async (args) => {
          const parentId = parent.sessionId;
          if (!parentId) return toolText('This session has no id yet; try again in a moment.', true);
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return toolText('prompt is required.', true);
          const meta = await getSessionMeta(parent.owner.uid);
          const refusal = spawnRefusal({ depth: sessionDepth(meta.parents, parentId), runningChildren: runningChildren(parentId, childIdsOf(meta.parents, parentId)) });
          if (refusal) return toolText(refusal, true);
          const model = String(args.model ?? '').trim();
          if (model && parent.models.length > 0 && !parent.models.some((m) => m.value === model)) {
            return toolText(`Unknown model "${model}". Available: ${parent.models.map((m) => m.value).join(', ')}. Omit model to use the default.`, true);
          }
          const title = cleanChildTitle(String(args.title ?? ''));
          const settings = await getSettings(parent.owner.uid);
          const child = newEntry({ uid: parent.owner.uid, projectId: parent.owner.projectId, cwd: parent.cwd, settings, parentSessionId: parentId, model });
          child.title = title;
          child.reportToParent = true;
          pending.add(child);
          startQuery(child, {});
          injectUserText(child, prompt);
          // claude names the session on the first turn's system.init.
          for (let i = 0; i < 300 && !child.sessionId && child.q; i++) await new Promise((r) => setTimeout(r, 100));
          if (!child.sessionId) return toolText(`Started child session "${title}", but it has not reported an id yet. Its answer will still arrive as a message when it finishes.`);
          try { await renameSession(child.sessionId, title, { dir: child.cwd }); child.title = title; broadcast(child, { type: 'title', title }); } catch {}
          return toolText(`Started child session "${title}" (id ${child.sessionId}). It is working in the background; its answer will arrive as a message starting with "[Child session" when it finishes. Do not wait or poll for it.`);
        },
      ),
      tool(
        'send_to_child_session',
        'Send a follow-up message to one of this session\'s child sessions (more instructions, a question, a correction). The child\'s answer arrives later as a message starting with "[Child session".',
        {
          child_id: z.string().describe('The child session id returned by spawn_child_session or list_child_sessions'),
          message: z.string().describe('The message for the child'),
        },
        async (args) => {
          const parentId = parent.sessionId;
          const childId = String(args.child_id ?? '').trim();
          const message = String(args.message ?? '').trim();
          if (!parentId || !childId || !message) return toolText('child_id and message are required.', true);
          const meta = await getSessionMeta(parent.owner.uid);
          if (meta.parents[`claude:${childId}`] !== parentId) return toolText(`${childId} is not a child session of this session. Use list_child_sessions to see them.`, true);
          const child = await wakeSession(parent, childId);
          if (!child) return toolText('That child session is open in a classic Claude tab and cannot be messaged from here.', true);
          child.reportToParent = true;
          injectUserText(child, message);
          return toolText(`Delivered to "${child.title || childId}". Its answer will arrive as a message starting with "[Child session".`);
        },
      ),
      tool(
        'list_child_sessions',
        'List this session\'s child sessions with their ids, titles and whether each is working, waiting for the user, idle or not running.',
        {},
        async () => {
          const parentId = parent.sessionId;
          if (!parentId) return toolText('No child sessions.');
          const meta = await getSessionMeta(parent.owner.uid);
          const ids = childIdsOf(meta.parents, parentId);
          if (ids.length === 0) return toolText('No child sessions.');
          const lines = await Promise.all(ids.map(async (id) => {
            const live = byId.get(id);
            let title = live?.title ?? null;
            if (!title) { try { title = (await getSessionInfo(id, { dir: parent.cwd }))?.summary?.trim() || null; } catch {} }
            const state = live ? (live.pendingAsks.size > 0 ? 'waiting for the user' : live.thinking ? 'working' : 'idle') : 'not running';
            return `- ${id} "${title ?? id.slice(0, 8)}": ${state}`;
          }));
          return toolText(lines.join('\n'));
        },
      ),
    ],
  });
}

// ----- routes --------------------------------------------------------------

export function registerSdkSessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project?: string; resume?: string; wire?: string; parent?: string } }>(
    '/ws/sdk-session',
    { websocket: true },
    async (socket, req) => {
      const uid = getUserId(req as any);
      if (!uid) { send(socket, { type: 'error', message: 'unauthorized' }); try { socket.close(); } catch {} return; }
      const projectId = req.query.project;
      const resumeId = req.query.resume || undefined;
      const project = projectId ? await getProject(uid, projectId) : null;
      if (!project) { send(socket, { type: 'error', message: 'project required or not found' }); try { socket.close(); } catch {} return; }

      // Attach to the live entry when the session is already running.
      if (resumeId && byId.has(resumeId)) {
        const entry = byId.get(resumeId)!;
        attachClient(entry, socket);
        send(socket, startedFrame(entry, true));
        send(socket, bangStateFrame(entry));
        for (const [id, ask] of entry.pendingAsks) send(socket, { type: 'ask', data: askEvent(id, ask) });
        return;
      }

      // Claude Session invariant (rule-394): refuse a session the cli bridge
      // is driving — two processes would interleave writes to one jsonl.
      if (resumeId && liveBridge(resumeId) === 'cli') {
        send(socket, { type: 'error', message: 'This session is open in a Claude tab — use that tab, or close it first.' });
        send(socket, { type: 'exit', code: 'open-elsewhere' });
        try { socket.close(); } catch {}
        return;
      }

      const settings = await getSettings(uid);
      // Model: web.WireCaptureSession → server.ObserveWireSession. Honoured
      // only while the proxy is listening; `started.wire` tells the client.
      const observeWire = req.query.wire === '1' && wireBaseUrl() !== null;
      if (observeWire && resumeId) registerWireSession(resumeId, project.path);
      const entry = newEntry({
        uid, projectId: project.id, cwd: project.path, settings, resumeId, observeWire,
        // Only a fresh session can be made a child; a resume keeps its link.
        parentSessionId: !resumeId && /^[A-Za-z0-9-]{8,64}$/.test(req.query.parent ?? '') ? req.query.parent! : null,
      });
      if (resumeId) { byId.set(resumeId, entry); markLive(resumeId, 'sdk'); }
      else pending.add(entry);
      if (resumeId) {
        try { entry.title = (await getSessionInfo(resumeId, { dir: project.path }))?.summary?.trim() || null; } catch {}
      }
      startQuery(entry, { resume: resumeId });
      if (resumeId) startWatcher(entry);
      attachClient(entry, socket);
      send(socket, startedFrame(entry, false));
    },
  );

  // Model: server.ListSdkSessions — the same jsonl directory as ListSessions,
  // read through the SDK so the row title is its summary (custom title → AI
  // title → first prompt).
  app.get<{ Params: { id: string } }>('/api/projects/:id/sdk-sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const list = await listSessions({ dir: project.path, includeWorktrees: false });
    return {
      sessions: list.map((s) => ({
        sessionId: s.sessionId,
        title: s.summary,
        customTitle: s.customTitle ?? null,
        firstPrompt: s.firstPrompt ?? null,
        lastModified: s.lastModified,
        liveIn: liveBridge(s.sessionId),
      })),
    };
  });

  // Model: server.ReadSdkTranscript — getSessionMessages() paged the same
  // way as ReadTranscript: events + startIndex/endIndex/total.
  app.get<{ Params: { id: string; sid: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/projects/:id/sdk-sessions/:sid/transcript',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      let msgs;
      try { msgs = await getSessionMessages(req.params.sid, { dir: project.path }); }
      catch { return reply.code(404).send({ error: 'session transcript not found' }); }
      const total = msgs.length;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const before = req.query.before != null ? Number(req.query.before) : total;
      const endIndex = Math.max(0, Math.min(total, Number.isFinite(before) ? before : total));
      const startIndex = Math.max(0, endIndex - limit);
      const events = msgs.slice(startIndex, endIndex).map((m) => ({ type: m.type, uuid: m.uuid, message: m.message }));
      return { events, startIndex, endIndex, total };
    },
  );

  // Model: server.RenameSession — appends a custom-title record; the resume
  // list and any live tab pick it up as the session's summary.
  app.post<{ Params: { id: string; sid: string }; Body: { title?: string } }>(
    '/api/projects/:id/sdk-sessions/:sid/rename',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const title = String(req.body?.title ?? '').trim();
      if (!title) return reply.code(400).send({ error: 'title required' });
      try { await renameSession(req.params.sid, title, { dir: project.path }); }
      catch (e) { return reply.code(500).send({ error: `rename failed: ${String(e)}` }); }
      const entry = byId.get(req.params.sid);
      if (entry) { entry.title = title; broadcast(entry, { type: 'title', title }); }
      return { ok: true, title };
    },
  );
}
