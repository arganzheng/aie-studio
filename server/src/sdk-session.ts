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
  type PermissionUpdate,
  type SlashCommand,
  type ModelInfo,
  createSdkMcpServer,
  tool, forkSession,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mapContextUsage, type ContextSnapshot } from './context-usage.js';
import {
  CHILD_TOOLS_INSTRUCTIONS, MAX_NOTES_PER_TURN, childLimits, cleanResultSchema, childBrief, childIdsOf, childReport, cleanGroup, joinReports, cleanChildTitle, isTurnResult, lastModelOf, sessionDepth, spawnRefusal,
  worktreePreface, type ChildStop,
} from './child-sessions.js';
import { createWorktree, isWorktreeName, listProjectSessions, realPath, sessionCwd, worktreeNameOf, worktreeNote, worktreePath, worktreeStatus } from './worktrees.js';
import {
  MAX_RESULT_SCHEMA_CHARS, getChildTerms, getHeldReports, getOwedReports, putChildTerms, getProject, getSessionMeta, getSettings, listUserIds, putHeldReports, putOwedReports, putSessionMeta, setParent,
  type HeldReports, type OwedReports, type Settings,
  unarchiveOnUse,
  setSessionStatus,
} from './store.js';
import { getUserId } from './auth.js';
import { runBang, bangContextBlocks, type BangResult, type RunningBang } from './shell-exec.js';
import { publishSessionEvent, type SessionOwner } from './notify.js';
import { askSummary, toSummary } from './inbox.js';
import { isEffortLevel } from './models.js';
import { markLive, unmarkLive, liveBridge, type LiveState } from './live-sessions.js';
import { activityAfter } from './session-tool-activity.js';
import { STATUS_INSTRUCTIONS, parseStatus } from './session-status.js';
import {
  DEFAULT_MODE, PLAN_MODE_DENIAL, PLAN_TOOL, describePermission, isOwnTool, isSessionMode, permissionDenial, permissionSummary, planOf, planRejection, sessionRules,
  type PermissionRequest, type SessionMode,
} from './permission-mode.js';
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
  // 'plan': the agent handed its plan over (ExitPlanMode) and waits for the
  // user's approval (model: Session.mode).
  // 'permission': a tool call the CLI wants a human for (acceptEdits / auto).
  kind: 'question' | 'plan' | 'permission';
  permission?: PermissionRequest;
  suggestions?: PermissionUpdate[];
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
  // Where claude runs: the project directory, or the session's own git
  // worktree under it (model: Session.worktree).
  cwd: string;
  // The project's directory — what session lookups by project use.
  projectPath: string;
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
  // Opened by the parent's agent (spawn tool), as opposed to by the user.
  spawnedByAgent: boolean;
  // What the user typed into this session since its last turn ended. If it
  // is an agent-spawned child, the parent is told (model: Session.children
  // rule "interventions").
  userNotes: string[];
  // stop_child_session interrupted the running turn: its report says so.
  stoppedByParent: boolean;
  // The batch label the parent's agent gave this child (SessionMeta.groups).
  group: string;
  // The title the parent's agent gave this child ('' = none, or the user
  // has renamed it since).
  givenTitle: string;
  // Model: ChildTerms — the shape its parent's agent set for its answers
  // (null = free text). A query option, so it is applied each time the
  // process starts.
  resultSchema: Record<string, unknown> | null;
  // Model: Session.mode. modeBeforePlan: where an approved plan returns to.
  mode: SessionMode;
  modeBeforePlan: SessionMode;
  // Model: Session.activity — the tool call the running turn last made.
  activity: string;
  // Compacting its conversation right now (SDK status event).
  compacting: boolean;
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
    let kind: PendingAsk['kind'] | null = toolName === 'AskUserQuestion' ? 'question' : toolName === PLAN_TOOL ? 'plan' : null;
    if (!kind) {
      // Plan mode: what the SDK would have asked a human about is refused.
      if (entry.mode === 'plan') return { behavior: 'deny', message: PLAN_MODE_DENIAL };
      // Bypass never gets here for an ordinary tool; the app's own tools
      // need no one's leave in any mode.
      if (entry.mode === 'bypassPermissions' || isOwnTool(toolName)) return { behavior: 'allow', updatedInput: input };
      kind = 'permission';
    }
    const id = opts.requestId;
    return new Promise<PermissionResult>((resolve) => {
      const ask: PendingAsk = { kind, input, toolUseID: opts.toolUseID, resolve, timer: null };
      if (kind === 'permission') {
        ask.permission = describePermission(toolName, input, opts);
        ask.suggestions = opts.suggestions;
      }
      entry.pendingAsks.set(id, ask);
      if (entry.clients.size === 0) armAsk(entry, id);
      opts.signal.addEventListener('abort', () => {
        if (entry.pendingAsks.delete(id)) {
          if (ask.timer) clearTimeout(ask.timer);
          broadcast(entry, { type: 'ask_cancel', id });
          resolve({ behavior: 'deny', message: 'Interrupted' });
        }
      });
      broadcast(entry, askFrame(id, ask));
      publishSessionEvent(entry.owner, 'awaiting', entry.sessionId, entry.title, kind === 'plan' ? 'Review the plan' : ask.permission ? permissionSummary(ask.permission) : askSummary(input));
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

// What a client is sent for a pending ask: the question form, or the plan
// to approve.
function askFrame(id: string, ask: PendingAsk) {
  if (ask.kind === 'permission') return { type: 'permission_ask', id, request: ask.permission };
  return ask.kind === 'plan' ? { type: 'plan_ask', id, plan: planOf(ask.input) } : { type: 'ask', data: askEvent(id, ask) };
}

// The user settled a plan: approved (the session leaves plan mode and the
// agent goes ahead) or sent back, with or without a word on what to change.
function settlePlan(entry: SdkEntry, id: string, approve: boolean, feedback?: unknown): boolean {
  const ask = entry.pendingAsks.get(id);
  if (!ask || ask.kind !== 'plan') return false;
  entry.pendingAsks.delete(id);
  if (ask.timer) clearTimeout(ask.timer);
  if (approve) {
    // Back to the mode the session was in before it went to plan.
    const next = entry.modeBeforePlan;
    setEntryMode(entry, next);
    ask.resolve({ behavior: 'allow', updatedInput: ask.input, updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] });
  } else {
    ask.resolve({ behavior: 'deny', message: planRejection(feedback) });
  }
  broadcast(entry, { type: 'plan_done', id, approved: approve });
  return true;
}

// The user answered a permission request: allow (once, or with the CLI's
// suggested rule kept for this session) or deny.
function settlePermission(entry: SdkEntry, id: string, allow: boolean, opts: { remember?: boolean; note?: unknown } = {}): boolean {
  const ask = entry.pendingAsks.get(id);
  if (!ask || ask.kind !== 'permission') return false;
  entry.pendingAsks.delete(id);
  if (ask.timer) clearTimeout(ask.timer);
  if (allow) {
    const rules = opts.remember ? sessionRules(ask.suggestions) : [];
    ask.resolve({ behavior: 'allow', updatedInput: ask.input, ...(rules.length ? { updatedPermissions: rules } : {}) });
  } else {
    ask.resolve({ behavior: 'deny', message: permissionDenial(opts.note) });
  }
  broadcast(entry, { type: 'permission_done', id, allowed: allow });
  return true;
}

// Record the session's mode, tell the clients, keep it for the next resume.
function setEntryMode(entry: SdkEntry, mode: SessionMode) {
  if (entry.mode === mode) return;
  if (mode === 'plan') entry.modeBeforePlan = entry.mode;
  entry.mode = mode;
  broadcast(entry, { type: 'permission_mode', mode });
  if (entry.sessionId) void saveTerms(entry);
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
      permissionMode: entry.mode,
      allowDangerouslySkipPermissions: true,
      enableFileCheckpointing: true,
      env: sdkEnv(entry.observeWire),
      pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
      stderr: (data) => broadcast(entry, { type: 'stderr', data }),
      canUseTool: makeCanUseTool(entry),
      mcpServers: { ...(entry.childTools ? { aie: childToolsServer(entry) } : {}), aie_status: statusServer() },
      outputFormat: entry.resultSchema ? { type: 'json_schema', schema: entry.resultSchema } : undefined,
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
    let next = setParent(meta, `claude:${newId}`, parent);
    if (next === meta && meta.parents[`claude:${newId}`] !== parent) return;
    // A re-id keeps the mark of who opened it.
    const byAgent = entry.spawnedByAgent || (oldId !== null && meta.agentSpawned.includes(`claude:${oldId}`));
    if (byAgent && !next.agentSpawned.includes(`claude:${newId}`)) next = { ...next, agentSpawned: [...next.agentSpawned, `claude:${newId}`] };
    const group = entry.group || (oldId ? meta.groups[`claude:${oldId}`] : '') || '';
    if (group && next.groups[`claude:${newId}`] !== group) next = { ...next, groups: { ...next.groups, [`claude:${newId}`]: group } };
    if (next !== meta) await putSessionMeta(entry.owner.uid, next);
    entry.parentSessionId = parent;
    if (byAgent) entry.spawnedByAgent = true;
    if (oldId) await editOwed(entry.owner.uid, (r) => { delete r[oldId]; });
    saveOwed(entry);
  } catch {}
}

// ----- what children owe their parents, on disk (model: OwedReport) ---------

// One writer at a time per user: these are read-modify-write.
const owedChains = new Map<string, Promise<void>>();
function editOwed(uid: string, edit: (r: OwedReports) => void): Promise<void> {
  const next = (owedChains.get(uid) ?? Promise.resolve()).then(async () => {
    const r = await getOwedReports(uid);
    const before = JSON.stringify(r);
    edit(r);
    if (JSON.stringify(r) !== before) await putOwedReports(uid, r);
  }).catch(() => {});
  owedChains.set(uid, next);
  return next;
}

// Mirror the entry's terms to disk under its id (dropping `oldId`'s, when
// claude re-ids the session).
const termsChains = new Map<string, Promise<void>>();
function saveTerms(entry: SdkEntry, oldId?: string | null) {
  const id = entry.sessionId;
  if (!id) return;
  const uid = entry.owner.uid;
  const terms = { ...(entry.resultSchema ? { resultSchema: entry.resultSchema } : {}), ...(entry.mode !== 'bypassPermissions' ? { mode: entry.mode } : {}) };
  const has = Object.keys(terms).length > 0;
  const next = (termsChains.get(uid) ?? Promise.resolve()).then(async () => {
    const all = await getChildTerms(uid);
    if (!has && !(id in all) && !(oldId && oldId in all)) return;
    if (oldId) delete all[oldId];
    if (has) all[id] = terms; else delete all[id];
    await putChildTerms(uid, all);
  }).catch(() => {});
  termsChains.set(uid, next);
  return next;
}

// Does this turn end in a report to the parent?
function owesReport(entry: SdkEntry): boolean {
  return entry.parentSessionId !== null && (entry.reportToParent || (entry.spawnedByAgent && entry.userNotes.length > 0));
}

// Mirror the entry's debt to disk (or clear it).
function saveOwed(entry: SdkEntry) {
  const id = entry.sessionId;
  if (!id) return;
  const owed = owesReport(entry) ? {
    parentId: entry.parentSessionId!,
    projectId: entry.owner.projectId,
    cwd: entry.projectPath, // the project: a session's own directory is looked up from it
    title: entry.title || id.slice(0, 8),
    requested: entry.reportToParent,
    notes: [...entry.userNotes],
  } : null;
  void editOwed(entry.owner.uid, (r) => { if (owed) r[id] = owed; else delete r[id]; });
}

function onSdkMessage(entry: SdkEntry, m: any) {
  touchActivity(entry);
  applyTaskEvent(entry.tasks, m);
  const activity = activityAfter(m, entry.cwd);
  if (activity !== null) entry.activity = activity;
  if (m?.type === 'system' && m?.subtype === 'init') {
    const sid: string | undefined = m.session_id;
    if (sid && entry.sessionId !== sid) {
      void linkToParent(entry, entry.sessionId, sid);
      if (entry.sessionId) { byId.delete(entry.sessionId); unmarkLive(entry.sessionId, 'sdk'); }
      const oldId = entry.sessionId;
      entry.sessionId = sid;
      void saveTerms(entry, oldId);
      byId.set(sid, entry);
      markLive(sid, 'sdk');
      pending.delete(entry);
      if (entry.observeWire) registerWireSession(sid, entry.cwd);
      stopWatcher(entry);
      startWatcher(entry);
    }
    if (typeof m.model === 'string') entry.model = m.model;
  }
  if (m?.type === 'system' && m?.subtype === 'status') {
    entry.compacting = m.status === 'compacting';
    // The CLI reports a mode change it made itself (a plan was approved).
    if (isSessionMode(m.permissionMode)) setEntryMode(entry, m.permissionMode);
  }
  if (m?.type === 'result') {
    entry.thinking = false;
    entry.compacting = false;
    if (isTurnResult(m)) {
      // The parent hears about this turn if it asked for it, or if the user
      // stepped into a child the parent's agent opened.
      const requested = entry.reportToParent;
      const notes = entry.userNotes.splice(0);
      const stopped: ChildStop | undefined = entry.stoppedByParent ? 'parent' : undefined;
      entry.reportToParent = false;
      entry.stoppedByParent = false;
      saveOwed(entry);
      if (requested || notes.length > 0) void reportToParent(entry, m, { requested, notes, stopped });
    }
    refreshContext(entry);
    scheduleTitleRefresh(entry);
    if (entry.clients.size === 0) scheduleKillIfIdle(entry);
    // Model: Session.status — what the agent said it is now waiting for.
    const said = parseStatus(m.result);
    const status = isTurnResult(m) && m.subtype === 'success' ? said.status : null;
    if (entry.sessionId) void setSessionStatus(entry.owner.uid, `claude:${entry.sessionId}`, status);
    if (entry.pendingAsks.size === 0) {
      if (status?.tone === 'needs-you') publishSessionEvent(entry.owner, 'awaiting', entry.sessionId, entry.title, status.label);
      else publishSessionEvent(entry.owner, 'done', entry.sessionId, entry.title, toSummary(said.text));
    }
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
    let t = info?.summary?.trim();
    // The name its parent gave a child must survive claude's own AI title,
    // which is written later and would win. A rename by the user (a custom
    // title other than ours) ends that.
    // The name its parent gave a child — or the user gave it since — must
    // survive claude's own AI title: claude keeps appending that, and the
    // newest title record wins. (The SDK reports an AI title as customTitle
    // too, so a rename by the user cannot be told from one here; the rename
    // routes tell us instead — userRenamedSdkSession.)
    if (entry.givenTitle) {
      try { await renameSession(entry.sessionId, entry.givenTitle, { dir: entry.cwd }); t = entry.givenTitle; } catch {}
    }
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
    // Writing while a plan waits is the answer to it: the plan goes back and
    // the message says why.
    for (const [id, ask] of entry.pendingAsks) {
      if (ask.kind === 'plan') settlePlan(entry, id, false);
      // Same for a tool call waiting for leave: the reply stands in for "no".
      else if (ask.kind === 'permission') settlePermission(entry, id, false, { note: 'they replied instead — see their next message' });
    }
    if (entry.sessionId) void unarchiveOnUse(entry.owner.uid, `claude:${entry.sessionId}`).then(() => setSessionStatus(entry.owner.uid, `claude:${entry.sessionId}`, null));
    const uuid = randomUUID();
    const bang = entry.pendingBang.splice(0).map((b) => b.result);
    const um = userMessage(uuid, text, images, bang);
    entry.thinking = true;
    touchActivity(entry);
    if (entry.userNotes.length < MAX_NOTES_PER_TURN) {
      entry.userNotes.push([text, images.length > 0 ? `[${images.length} image${images.length === 1 ? '' : 's'} attached]` : ''].filter(Boolean).join('\n'));
      saveOwed(entry);
    }
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
  if (msg.type === 'set_permission_mode') {
    const mode = msg.mode;
    if (!isSessionMode(mode)) { send(socket, { type: 'error', message: `unknown mode: ${String(mode)}` }); return; }
    try {
      await entry.q.setPermissionMode(mode);
      setEntryMode(entry, mode);
    } catch (e) {
      send(socket, { type: 'error', message: `set_permission_mode failed: ${String(e)}` });
    }
    return;
  }
  if (msg.type === 'permission_response') {
    settlePermission(entry, String(msg.id ?? ''), msg.allow === true, { remember: msg.remember === true });
    return;
  }
  if (msg.type === 'plan_response') {
    settlePlan(entry, String(msg.id ?? ''), msg.approve === true, msg.feedback);
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
    if (!ask || ask.kind !== 'question') return;
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
    compacting: entry.compacting,
    model: entry.model,
    mode: entry.mode,
    requestedModel: entry.requestedModel || null,
    effort: entry.effort,
    wire: entry.observeWire,
    title: entry.title,
    context: entry.context,
    // The session's own git worktree, by name (null = the project directory).
    worktree: entry.cwd === entry.projectPath ? null : path.basename(entry.cwd),
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
// The user renamed a session: for a child still holding the title its parent
// gave it, that is now the one to keep.
export function userRenamedSdkSession(sessionId: string, title: string) {
  const entry = byId.get(sessionId);
  if (!entry) return;
  if (entry.givenTitle) entry.givenTitle = title;
  entry.title = title;
}
// More for the session's row: what its running turn is doing.
export function sdkLiveDetail(sessionId: string): { activity?: string } {
  const entry = byId.get(sessionId);
  return entry?.thinking && entry.activity ? { activity: entry.activity } : {};
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
// `silent`: don't tell the session's parent (the user is stopping the whole
// tree — a report would only start the parent again).
export function stopSdkSession(sessionId: string, uid: string, opts: { silent?: boolean } = {}): boolean {
  const entry = byId.get(sessionId);
  if (!entry || entry.owner.uid !== uid) return false;
  const owed = owesReport(entry);
  const why = { requested: entry.reportToParent, notes: entry.userNotes.splice(0), stopped: 'user' as const };
  entry.reportToParent = false;
  saveOwed(entry);
  broadcast(entry, { type: 'exit', code: 'stopped' });
  destroy(entry);
  // The turn died with the process: the parent would wait for ever.
  if (owed && !opts.silent) void reportToParent(entry, null, why);
  return true;
}

// A bridge entry with no query yet (startQuery starts one).
function newEntry(o: {
  uid: string; projectId: string; cwd: string; projectPath: string; settings: Settings;
  resumeId?: string; parentSessionId?: string | null; observeWire?: boolean; model?: string; spawnedByAgent?: boolean; group?: string;
}): SdkEntry {
  return {
    cwd: o.cwd,
    projectPath: o.projectPath,
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
    spawnedByAgent: o.spawnedByAgent === true,
    userNotes: [],
    stoppedByParent: false,
    group: o.group ?? '',
    givenTitle: '',
    resultSchema: null,
    mode: DEFAULT_MODE,
    modeBeforePlan: DEFAULT_MODE,
    activity: '',
    compacting: false,
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
async function wakeSession(who: { uid: string; projectId: string; projectPath: string }, sessionId: string, opts: { model?: string } = {}): Promise<SdkEntry | null> {
  const live = byId.get(sessionId);
  if (live) return live.owner.uid === who.uid ? live : null;
  if (liveBridge(sessionId) === 'cli') return null;
  const settings = await getSettings(who.uid);
  const entry = newEntry({ uid: who.uid, projectId: who.projectId, cwd: await sessionCwd(who.projectPath, sessionId), projectPath: who.projectPath, settings, resumeId: sessionId, model: opts.model });
  byId.set(sessionId, entry);
  markLive(sessionId, 'sdk');
  await loadTreePosition(entry);
  try { entry.title = (await getSessionInfo(sessionId, { dir: who.projectPath }))?.summary?.trim() || null; } catch {}
  startQuery(entry, { resume: sessionId });
  startWatcher(entry);
  // Nobody is attached: end the process again once it goes quiet.
  scheduleKillIfIdle(entry);
  return entry;
}
const whoOf = (e: SdkEntry) => ({ uid: e.owner.uid, projectId: e.owner.projectId, projectPath: e.projectPath });

// The entry's worktree name, when it runs in one.
async function worktreeOf(entry: SdkEntry): Promise<string | null> {
  if (entry.cwd === entry.projectPath) return null;
  return worktreeNameOf(await realPath(entry.projectPath), await realPath(entry.cwd));
}

// A resumed session's place in the tree, from SessionMeta.
async function loadTreePosition(entry: SdkEntry) {
  if (!entry.sessionId) return;
  try {
    const meta = await getSessionMeta(entry.owner.uid);
    const key = `claude:${entry.sessionId}`;
    entry.parentSessionId = meta.parents[key] ?? null;
    entry.spawnedByAgent = meta.agentSpawned.includes(key);
    const terms = (await getChildTerms(entry.owner.uid))[entry.sessionId];
    entry.resultSchema = terms?.resultSchema ?? null;
    if (terms?.mode && entry.mode !== terms.mode) {
      entry.mode = terms.mode;
      // The query may already be up with the default mode.
      void entry.q?.setPermissionMode(terms.mode).catch(() => {});
      broadcast(entry, { type: 'permission_mode', mode: terms.mode });
    }
  } catch {}
}

// A child finished a turn its parent asked for: hand the answer to the
// parent, waking it if needed.
async function reportToParent(child: SdkEntry, result: any, why: { requested: boolean; notes: string[]; stopped?: ChildStop }) {
  const parentId = child.parentSessionId;
  if (!child.sessionId || !parentId) return;
  // A turn only the user asked for is the parent's business only when its
  // own agent opened this child.
  if (!why.requested && !child.spawnedByAgent) return;
  try {
    const ok = !why.stopped && result?.subtype === 'success' && result?.is_error !== true;
    const wtName = await worktreeOf(child);
    const wt = wtName ? await worktreeStatus(child.projectPath, wtName) : null;
    await deliverReport(whoOf(child), parentId, childReport({
      worktreeNote: wt ? worktreeNote(wt) : undefined,
      title: child.title || child.sessionId.slice(0, 8),
      sessionId: child.sessionId,
      ok,
      result: parseStatus(result?.result).text,
      errorKind: ok ? undefined : String(result?.subtype ?? 'error'),
      userNotes: why.notes,
      stopped: why.stopped,
      structured: result?.structured_output,
    }), child);
  } catch {}
}

// ----- "wait for all" (model: HeldReports) ---------------------------------

const heldChains = new Map<string, Promise<unknown>>();
function editHeld<T>(uid: string, edit: (h: HeldReports) => T): Promise<T> {
  const next = (heldChains.get(uid) ?? Promise.resolve()).then(async () => {
    const h = await getHeldReports(uid);
    const before = JSON.stringify(h);
    const out = edit(h);
    if (JSON.stringify(h) !== before) await putHeldReports(uid, h);
    return out;
  });
  heldChains.set(uid, next.catch(() => {}));
  return next;
}

// Children of `parentId` whose running turn will end in a report.
function workingChildren(parentId: string, except?: SdkEntry): number {
  let n = 0;
  for (const e of [...byId.values(), ...pending]) if (e !== except && e.parentSessionId === parentId && e.reportToParent) n++;
  return n;
}

// Hand a report to the parent — at once, or, when the parent asked to wait
// for all its children, once the last working one has reported.
async function deliverReport(who: { uid: string; projectId: string; projectPath: string }, parentId: string, text: string, from?: SdkEntry) {
  const out = await editHeld(who.uid, (h) => {
    const hold = h[parentId];
    if (!hold) return text;
    hold.reports.push(text);
    if (workingChildren(parentId, from) > 0) return null;
    delete h[parentId];
    return joinReports(hold.reports);
  });
  if (out === null) return;
  const parent = await wakeSession(who, parentId);
  if (parent) injectUserText(parent, out);
}

// Model: server start — a crash (or a kill) took child sessions down mid-turn.
// Tell each parent its child was interrupted, with whatever the user had
// told that child, instead of leaving it waiting.
export async function recoverChildReports(): Promise<number> {
  let delivered = 0;
  for (const uid of await listUserIds()) {
    const owed = await getOwedReports(uid).catch(() => ({} as OwedReports));
    for (const [childId, rec] of Object.entries(owed)) {
      if (byId.has(childId)) continue; // running again already: it will report itself
      try {
        await deliverReport({ uid, projectId: rec.projectId, projectPath: rec.cwd }, rec.parentId,
          childReport({ title: rec.title || childId.slice(0, 8), sessionId: childId, ok: false, result: '', userNotes: rec.notes, stopped: 'restart' }));
        delivered++;
      } catch {}
      await editOwed(uid, (r) => { delete r[childId]; });
    }
    // Reports collected for a "wait for all" whose children are all gone.
    const flush = await editHeld(uid, (h) => {
      const out: { parentId: string; projectId: string; cwd: string; text: string }[] = [];
      for (const [parentId, hold] of Object.entries(h)) {
        if (workingChildren(parentId) > 0) continue;
        if (hold.reports.length > 0) out.push({ parentId, projectId: hold.projectId, cwd: hold.cwd, text: joinReports(hold.reports) });
        delete h[parentId];
      }
      return out;
    }).catch(() => []);
    for (const f of flush) {
      try {
        const parent = await wakeSession({ uid, projectId: f.projectId, projectPath: f.cwd }, f.parentId);
        if (parent) { injectUserText(parent, f.text); delivered++; }
      } catch {}
    }
  }
  return delivered;
}

// Give a new child its title. claude names the session before it has
// written its transcript, and a rename needs the file: keep trying briefly.
async function nameChildSession(child: SdkEntry, title: string) {
  for (let i = 0; i < 12 && child.sessionId; i++) {
    try {
      await renameSession(child.sessionId, title, { dir: child.cwd });
      child.title = title;
      broadcast(child, { type: 'title', title });
      return;
    } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
}

const toolText = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });

// The status-line rule, as the instructions of a server with no tools. It has
// a server of its own because the SDK tells the model a server's instructions
// once per server *name*: a resumed session that had already been told about
// `aie` never saw text added to it later. For the same reason, rename this
// server (aie_status_2, ...) when STATUS_INSTRUCTIONS changes in a way open
// sessions must pick up.
function statusServer() {
  return createSdkMcpServer({ name: 'aie_status', version: '1.0.0', instructions: STATUS_INSTRUCTIONS, tools: [] });
}

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
        'Open a child session: a separate, full Claude session in this project that works on `prompt` in the background. The user sees it under this session in the Sessions tree and can open it and talk to it. Returns immediately with the child id; the child\'s answer arrives later as a message starting with "[Child session". The child knows nothing of this conversation: give it the context in `background` and the job in `prompt`.',
        {
          title: z.string().describe('Short name shown in the Sessions tree, e.g. "Draft Apple Pay tests"'),
          background: z.string().describe('What the child must know about the wider work, since it sees none of this conversation: the overall goal, decisions already made and why, constraints and preferences the user stated, relevant files and branches. Write "none" only for a task that truly stands alone.'),
          prompt: z.string().describe('The task itself: what to do and what to report back'),
          model: z.string().optional().describe('Model for the child (an id or alias this session can use). Omit to use the default.'),
          group: z.string().optional().describe('A short label shared by children you open as one batch (e.g. "Python series review"): the user sees them together under it, with a done/total count.'),
          result_schema: z.record(z.string(), z.unknown()).optional().describe('A JSON Schema of type "object" for the child\'s answer. When given, the report carries JSON matching it instead of prose — use it when you will process the result mechanically. Put every field you need in `required`.'),
          isolation: z.enum(['shared', 'worktree']).optional().describe('"worktree": the child gets its own git worktree and branch (under .claude/worktrees/), branched from your current commit — use it when the child will edit files while you or other children are editing too. "shared" (default): it works in the same directory as you.'),
        },
        async (args) => {
          const parentId = parent.sessionId;
          if (!parentId) return toolText('This session has no id yet; try again in a moment.', true);
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return toolText('prompt is required.', true);
          const meta = await getSessionMeta(parent.owner.uid);
          // Read now, not when the session started: a change in Settings applies at once.
          const settings = await getSettings(parent.owner.uid);
          const refusal = spawnRefusal({ depth: sessionDepth(meta.parents, parentId), runningChildren: runningChildren(parentId, childIdsOf(meta.parents, parentId)) }, childLimits(settings));
          if (refusal) return toolText(refusal, true);
          const model = String(args.model ?? '').trim();
          if (model && parent.models.length > 0 && !parent.models.some((m) => m.value === model)) {
            return toolText(`Unknown model "${model}". Available: ${parent.models.map((m) => m.value).join(', ')}. Omit model to use the default.`, true);
          }
          const title = cleanChildTitle(String(args.title ?? ''));
          const schema = cleanResultSchema(args.result_schema, MAX_RESULT_SCHEMA_CHARS);
          if (schema && 'error' in schema) return toolText(schema.error, true);
          let cwd = parent.cwd;
          let wtBrief: string | undefined;
          let where = '';
          if (args.isolation === 'worktree') {
            try {
              const wt = await createWorktree(parent.projectPath, parent.cwd, title);
              cwd = wt.path;
              wtBrief = worktreePreface({ path: wt.path, branch: wt.branch, projectPath: parent.projectPath });
              where = ` It works in its own git worktree (.claude/worktrees/${wt.name}) on branch ${wt.branch}, created from your current commit; your uncommitted changes are not in it. Its report will say what to merge.`;
            } catch (e) {
              return toolText(`Could not create a worktree: ${String((e as Error).message)}. Open the child without isolation, or fix that first.`, true);
            }
          }
          const child = newEntry({ uid: parent.owner.uid, projectId: parent.owner.projectId, cwd, projectPath: parent.projectPath, settings, parentSessionId: parentId, model, spawnedByAgent: true, group: cleanGroup(args.group) });
          child.title = title;
          child.reportToParent = true;
          child.resultSchema = schema ? schema.schema : null;
          pending.add(child);
          startQuery(child, {});
          injectUserText(child, childBrief({ parentTitle: parent.title || parentId.slice(0, 8), parentId, background: String(args.background ?? ''), prompt, worktree: wtBrief }));
          // claude names the session on the first turn's system.init.
          for (let i = 0; i < 300 && !child.sessionId && child.q; i++) await new Promise((r) => setTimeout(r, 100));
          if (!child.sessionId) return toolText(`Started child session "${title}", but it has not reported an id yet. Its answer will still arrive as a message when it finishes.`);
          child.title = title;
          child.givenTitle = title;
          broadcast(child, { type: 'title', title });
          void nameChildSession(child, title);
          saveOwed(child);
          const terms = schema ? ' Its report will be JSON matching your schema.' : '';
          return toolText(`Started child session "${title}" (id ${child.sessionId}).${where}${terms} It is working in the background; its answer will arrive as a message starting with "[Child session" when it finishes. Do not wait or poll for it.`);
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
          const child = await wakeSession(whoOf(parent), childId);
          if (!child) return toolText('That child session is open in a classic Claude tab and cannot be messaged from here.', true);
          child.reportToParent = true;
          injectUserText(child, message);
          saveOwed(child);
          return toolText(`Delivered to "${child.title || childId}". Its answer will arrive as a message starting with "[Child session".`);
        },
      ),
      tool(
        'wait_for_child_sessions',
        'Receive the reports of your working child sessions together, in one message, when the last of them has finished — instead of one message (and one turn of yours) per child. Call it after opening or messaging several children when you have nothing else to do until all are done, then end your turn. Returns at once.',
        {},
        async () => {
          const parentId = parent.sessionId;
          if (!parentId) return toolText('This session has no id yet; try again in a moment.', true);
          const n = workingChildren(parentId);
          if (n === 0) return toolText('None of your child sessions is working right now, so there is nothing to wait for. Any report already sent is above in this conversation.');
          await editHeld(parent.owner.uid, (h) => { h[parentId] ??= { projectId: parent.owner.projectId, cwd: parent.projectPath, reports: [] }; });
          return toolText(`Waiting for ${n} child session${n === 1 ? '' : 's'}: their reports will arrive together in one message when the last one finishes. End your turn now; do not poll.`);
        },
      ),
      tool(
        'stop_child_session',
        'Stop what one of this session\'s child sessions is doing right now (it went the wrong way, or its work is no longer needed). The child keeps its conversation and can be given new instructions with send_to_child_session. A report saying it was stopped arrives as a message starting with "[Child session".',
        { child_id: z.string().describe('The child session id') },
        async (args) => {
          const parentId = parent.sessionId;
          const childId = String(args.child_id ?? '').trim();
          if (!parentId || !childId) return toolText('child_id is required.', true);
          const meta = await getSessionMeta(parent.owner.uid);
          if (meta.parents[`claude:${childId}`] !== parentId) return toolText(`${childId} is not a child session of this session. Use list_child_sessions to see them.`, true);
          const child = byId.get(childId);
          if (!child || !child.q || !child.thinking) return toolText(`"${child?.title || childId}" is not working right now; there is nothing to stop.`);
          child.stoppedByParent = true;
          child.reportToParent = true;
          for (const r of child.runningBang.values()) r.run.interrupt();
          try { await child.q.interrupt(); } catch (e) { child.stoppedByParent = false; return toolText(`Could not stop it: ${String(e)}`, true); }
          return toolText(`Stopping "${child.title || childId}". A report confirming it was stopped will arrive as a message.`);
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
            if (!title) { try { title = (await getSessionInfo(id, { dir: parent.projectPath }))?.summary?.trim() || null; } catch {} }
            const state = live ? (live.pendingAsks.size > 0 ? 'waiting for the user' : live.thinking ? 'working' : 'idle') : 'not running';
            const group = meta.groups[`claude:${id}`];
            return `- ${id} "${title ?? id.slice(0, 8)}"${group ? ` [${group}]` : ''}: ${state}`;
          }));
          return toolText(lines.join('\n'));
        },
      ),
    ],
  });
}

// ----- routes --------------------------------------------------------------

export function registerSdkSessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project?: string; resume?: string; wire?: string; parent?: string; worktree?: string } }>(
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
        for (const [id, ask] of entry.pendingAsks) send(socket, askFrame(id, ask));
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
      // A resumed session runs where it was started; a fresh one may name an
      // existing worktree of the project (web.NewChildSession "in a worktree").
      let cwd = project.path;
      if (resumeId) cwd = await sessionCwd(project.path, resumeId);
      else if (isWorktreeName(req.query.worktree)) {
        const dir = worktreePath(await realPath(project.path), req.query.worktree);
        if (await nodeFs.promises.stat(dir).then((st) => st.isDirectory(), () => false)) cwd = dir;
      }
      const entry = newEntry({
        uid, projectId: project.id, cwd, projectPath: project.path, settings, resumeId, observeWire,
        // Only a fresh session can be made a child; a resume keeps its link.
        parentSessionId: !resumeId && /^[A-Za-z0-9-]{8,64}$/.test(req.query.parent ?? '') ? req.query.parent! : null,
      });
      if (resumeId) { byId.set(resumeId, entry); markLive(resumeId, 'sdk'); }
      else pending.add(entry);
      if (resumeId) {
        await loadTreePosition(entry);
        try { entry.title = (await getSessionInfo(resumeId, { dir: project.path }))?.summary?.trim() || null; } catch {}
      }
      startQuery(entry, { resume: resumeId });
      if (resumeId) startWatcher(entry);
      attachClient(entry, socket);
      send(socket, startedFrame(entry, false));
    },
  );

  // Model: web.NewChildSession "with compacted context" — the child starts
  // as a copy of its parent's whole conversation (SDK forkSession), which is
  // then compacted, so it knows what the parent knows without carrying all of
  // it. The copy is what gets compacted — the parent's own conversation is
  // left as it is — and with the parent's model: the model that held the
  // conversation writes its summary, and the child carries on with it.
  // The compaction runs here, on a process nobody is attached to yet; the
  // tab the client opens next attaches to it.
  app.post<{ Params: { id: string; sid: string } }>('/api/projects/:id/sdk-sessions/:sid/fork-child', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const parentId = req.params.sid;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(parentId)) return reply.code(400).send({ error: 'bad session id' });
    try {
      const dir = await sessionCwd(project.path, parentId);
      const parentTitle = (await getSessionInfo(parentId, { dir }).catch(() => null))?.summary?.trim() || parentId.slice(0, 8);
      const title = `Child of ${parentTitle}`.slice(0, 60);
      const { sessionId } = await forkSession(parentId, { dir, title });
      const meta = await getSessionMeta(uid);
      const next = setParent(meta, `claude:${sessionId}`, parentId);
      if (next !== meta) await putSessionMeta(uid, next);
      const live = byId.get(parentId);
      const model = (live?.owner.uid === uid ? live.model || live.requestedModel : '')
        || lastModelOf(await getSessionMessages(parentId, { dir }).catch(() => []))
        || undefined;
      const entry = await wakeSession({ uid, projectId: project.id, projectPath: project.path }, sessionId, { model });
      if (entry) injectUserText(entry, '/compact');
      return { sessionId, title };
    } catch (e: any) {
      return reply.code(502).send({ error: String(e?.message ?? e) });
    }
  });

  // Model: server.ListSdkSessions — the same jsonl directory as ListSessions,
  // read through the SDK so the row title is its summary (custom title → AI
  // title → first prompt).
  app.get<{ Params: { id: string } }>('/api/projects/:id/sdk-sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const list = await listProjectSessions(project.path);
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
      try { await renameSession(req.params.sid, title, { dir: project.path }); userRenamedSdkSession(req.params.sid, title); }
      catch (e) { return reply.code(500).send({ error: `rename failed: ${String(e)}` }); }
      const entry = byId.get(req.params.sid);
      if (entry) { entry.title = title; broadcast(entry, { type: 'title', title }); }
      return { ok: true, title };
    },
  );
}
