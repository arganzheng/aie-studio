// Model: web.SdkChatPanel (page SdkChatView). The Agent-SDK Claude tab. A
// separate panel on purpose — it shares leaf components with ChatPanel
// (ChatInput, ElicitationHost, ImageAttachments, MarkdownLink, pickers) but
// none of ChatPanel's own code, so the `session` kind cannot regress from
// anything done here. Wire protocol: server ClaudeSdkSessionBridge
// (projects/claude-sdk-session/design.md).
import { Fragment, Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QueuedMessages, parseQueue, type QueuedView } from './QueuedMessages';
import type { SendMode } from './ChatInput';
import ReactMarkdown from 'react-markdown';
import { HistoryNotice, historyProblem } from './HistoryNotice';
import { logDebug } from '../lib/debugLog';
import { PlanStrip } from './PlanStrip';
import { foldPlan, isPlanTool, planToolSummary, type PlanToolCall } from '../lib/plan';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SendKey, Theme } from '../types';
import type { SessionPanelApi, TabActivity } from '../registry/tabRegistry';
import { CommentComposer, flashMessage, sleep, type NewComment } from './CommentComposer';
import { BookmarkButton, type NewBookmark } from './BookmarkButton';
import { MessageActions } from './MessageActions';
import { messageLink } from '../lib/messageActions';
import { copyText } from '../lib/clipboard';
import { toolMarkdown } from '../lib/toolMarkdown';
import type { PromptInsertion } from './ChatInput';
import { composeComment, type CommentMark, bookmarkLabel } from '../lib/review';
import type { ChatQuote } from '../lib/addToChat';
import { applyQuoteHighlights } from '../lib/quoteHighlight';
import { RichCopyButton, useRichCopy } from './RichCopy';
import type { ExportMessage } from '../lib/export/types';
import { awaitingUser, stripStatus } from '../lib/sessionStatus';
import { MODES, addPermissionAsk, isSessionMode, modeInfo, parsePermissionAsk, permissionHeadline, type PermissionAsk, type SessionMode } from '../lib/sessionMode';
import { parseAttachedFiles, withAttachedFiles } from '../lib/fileAttachments';
import { FileAttachmentStrip, SentFileChips, useFileAttachments } from './FileAttachments';

// Lazy like ChatPanel: the export pipeline only loads when ⤓ is clicked.
const ExportDialog = lazy(() => import('./ExportDialog').then((m) => ({ default: m.ExportDialog })));
import { ChatInput } from './ChatInput';
import { bangCommand, isBangInput, splitBangTexts } from '../lib/bang';
import { ClaudeUsageBadge, refreshClaudeUsage } from './ClaudeUsage';
import { ContextBadge, type ContextSnapshot } from './ContextUsage';
import { childLinkOfTool } from '../lib/childLink';
import { parseCompactNote } from '../lib/compactNote';
import { groupWork, type WorkItem, type WorkMsg } from '../lib/workGroups';
import { WorkGroupView } from './WorkGroupView';
import { liveActivity } from '../lib/liveActivity';
import { isCompactCommand, isInterruptNote, isSlashCommand } from '../lib/steering';
import { parseChildReports } from '../lib/childReport';
import { parseWatchReport, type WatchItem } from '../lib/watchReport';
import { withArrivedDuring } from '../lib/refetchMerge';
import { parseTaskNotifications, taskNoteFailed, taskNoteTitle } from '../lib/taskNotification';
import { parseParentContext, withParentContext, type ParentContext } from '../lib/parentContext';
import { summarizeSession } from '../api';
import { ImageAttachmentStrip, useImageAttachments, type ImageAttachment } from './ImageAttachments';
import { useElicitationHost } from './ElicitationHost';
import { MarkdownLink } from './MarkdownLink';
import { claudeAnswersFrom, parseAskUserQuestion } from '../lib/elicitation';
import { isSendKeyTrigger } from '../lib/sendKey';
import { toWireImages } from '../lib/imageAttachments';
import { isImageSizeNote, parseToolResultContent, type ToolOutput } from '../lib/toolResult';
import { makeRelPath } from '../lib/relPath';
import { BTW_COMMAND, btwQuestion, toCommandItems } from '../lib/commandPicker';
import type { ClaudeCliCatalog } from '../lib/claudeCatalog';
import { useAieCommands } from '../useAieCommands';
import { useClaudeModels, effortOptionsFor } from '../useClaudeModels';
import { openDuplex, type DuplexSocket } from '../lib/duplex';

// ----- message model ------------------------------------------------------

export type Msg =
  // at: when it was written (model: web.MessageActions shows it).
  | { id: string; role: 'user'; text: string; images?: string[]; uuid?: string; at?: number }
  // uuid / blockIdx: the jsonl record + content block this text came from —
  // the comment anchor (model: Comment.anchor = a:<uuid>:<blockIdx>).
  // at: when it was written (transcript timestamp, or arrival when live) —
  // model: web.WorkGroups times a stretch of work from these.
  | { id: string; role: 'assistant'; text: string; uuid?: string; blockIdx?: number; at?: number }
  // Claude's thinking between steps. text may be empty (not every thinking
  // block carries its text); ms: how long it took, when known.
  | { id: string; role: 'thinking'; text: string; at?: number; ms?: number }
  | { id: string; role: 'system'; text: string }
  // outputImages: images the tool returned (e.g. Read on a .png).
  // at / doneAt: when the call was made / its result came back.
  // step: the model response that made the call — calls made together in
  // one response fold into one row of a work group.
  | { id: string; role: 'tool'; name: string; input: any; toolUseId?: string; output?: string; outputImages?: string[]; at?: number; doneAt?: number; step?: string }
  // Model: web.BangCommand. bangId: the live command's id (absent when read
  // back from the transcript). pending: ran, but the model hasn't seen it yet
  // — it goes out with the next prompt.
  | { id: string; role: 'bang'; command: string; bangId?: string; result?: BangOutcome; pending?: boolean };

type BangOutcome = {
  stdout: string;
  stderr: string;
  code?: number | null;
  blocked?: string;
  timedOut?: boolean;
  interrupted?: boolean;
};

type Status = 'connecting' | 'replaying' | 'ready' | 'thinking' | 'reconnecting' | 'closed';

function shortId() { return Math.random().toString(36).slice(2, 9); }

// Model: web.ToolCopy — Copy on an opened tool call: the call (and its
// output) as Markdown; ✓ for a moment once copied.
function ToolCopyButton({ name, input, output, rel }: { name: string; input: any; output?: string; rel: (s: string) => string }) {
  const [done, setDone] = useState<null | boolean>(null);
  return (
    <button
      type="button"
      className="tool-popout-btn tool-copy-btn"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(toolMarkdown(name, input, output, rel)).then((ok) => { setDone(ok); window.setTimeout(() => setDone(null), 1200); });
      }}
      title={done === false ? 'Copy failed' : 'Copy as Markdown (the call and its output)'}
      aria-label="Copy as Markdown"
    >
      {done ? '✓' : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
      )}
    </button>
  );
}

// Stable per-message anchor for Review comments — same shape as ChatPanel so
// a comment made in either Claude tab kind resolves in the other.
function msgAnchor(m: Msg): string | null {
  if (m.role === 'user') return m.uuid ? `u:${m.uuid}` : null;
  if (m.role === 'assistant') return m.uuid ? `a:${m.uuid}:${m.blockIdx ?? 0}` : null;
  if (m.role === 'tool') return m.toolUseId ? `t:${m.toolUseId}` : null;
  return null;
}

function toExport(msgs: Msg[]): ExportMessage[] {
  return msgs.map((m): ExportMessage => {
    if (m.role === 'user') return { kind: 'user', text: m.text, images: m.images };
    if (m.role === 'assistant') return { kind: 'assistant', text: m.text };
    if (m.role === 'system') return { kind: 'system', text: m.text };
    if (m.role === 'thinking') return { kind: 'system', text: m.text ? `Thinking: ${m.text}` : 'Thinking' };
    if (m.role === 'bang') {
      const out = [m.result?.stdout, m.result?.stderr, m.result?.blocked && `Blocked: ${m.result.blocked}`].filter(Boolean).join('\n');
      return { kind: 'tool', name: 'Bash (!)', input: { command: m.command }, output: out };
    }
    return { kind: 'tool', name: m.name, input: m.input, output: m.output, images: m.outputImages };
  });
}

type Delta =
  | { kind: 'append'; msg: Msg }
  | { kind: 'tool_result'; toolUseId: string; output: string; images?: string[]; at?: number }
  // Claude Code writes a `!` command's output as its own user record.
  | { kind: 'bang_output'; stdout: string; stderr: string };

// One transcript / SDK message → message deltas. Both ReadSdkTranscript
// events and live SDKMessages have {type, uuid, message}.
function renderEvent(ev: any): Delta[] {
  const out: Delta[] = [];
  const uuid = typeof ev?.uuid === 'string' ? ev.uuid : undefined;
  // Transcript records carry when they were written; live messages don't.
  const at = (typeof ev?.timestamp === 'string' && Date.parse(ev.timestamp)) || Date.now();
  if (ev?.type === 'assistant' && ev.message) {
    (ev.message.content ?? []).forEach((block: any, blockIdx: number) => {
      if (block?.type === 'text' && block.text) {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'assistant', text: block.text, uuid, blockIdx, at } });
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : '', at } });
      } else if (block?.type === 'tool_use') {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'tool', name: block.name, input: block.input, toolUseId: block.id, at, step: typeof ev.message.id === 'string' ? ev.message.id : undefined } });
      }
    });
  } else if (ev?.type === 'user' && ev.message && !isImageSizeNote(ev)) {
    const texts: string[] = [];
    const images: string[] = [];
    const raw = ev.message.content;
    const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : [];
    for (const block of blocks) {
      if (block?.type === 'text') texts.push(block.text ?? '');
      else if (block?.type === 'image') {
        const src = block.source;
        if (src?.type === 'base64' && src.data && src.media_type) images.push(`data:${src.media_type};base64,${src.data}`);
      } else if (block?.type === 'tool_result') {
        const r = parseToolResultContent(block.content);
        out.push({ kind: 'tool_result', toolUseId: block.tool_use_id, output: r.text, images: r.images, at });
      }
    }
    const prompt: string[] = [];
    for (const part of splitBangTexts(texts)) {
      if (part.kind === 'input') out.push({ kind: 'append', msg: { id: shortId(), role: 'bang', command: part.command } });
      else if (part.kind === 'output') out.push({ kind: 'bang_output', stdout: part.stdout, stderr: part.stderr });
      else prompt.push(part.text);
    }
    if (prompt.length || images.length) {
      out.push({ kind: 'append', msg: { id: shortId(), role: 'user', text: prompt.join('\n'), images: images.length ? images : undefined, uuid, at } });
    }
  }
  return out;
}

export function buildFromEvents(events: any[], orphanResults: Map<string, ToolOutput>): Msg[] {
  const msgs: Msg[] = [];
  const pendingTools = new Map<string, Msg & { role: 'tool' }>();
  for (const ev of events) {
    for (const d of renderEvent(ev)) {
      if (d.kind === 'append') {
        if (d.msg.role === 'tool' && d.msg.toolUseId) {
          const cached = orphanResults.get(d.msg.toolUseId);
          if (cached !== undefined) { d.msg.output = cached.text; d.msg.outputImages = cached.images; orphanResults.delete(d.msg.toolUseId); }
          else pendingTools.set(d.msg.toolUseId, d.msg);
        }
        msgs.push(d.msg);
      } else if (d.kind === 'bang_output') {
        attachBangOutput(msgs, d);
      } else {
        const target = pendingTools.get(d.toolUseId);
        if (target && target.output === undefined) { target.output = d.output; target.outputImages = d.images; target.doneAt = d.at; pendingTools.delete(d.toolUseId); }
        else orphanResults.set(d.toolUseId, { text: d.output, images: d.images });
      }
    }
  }
  return msgs;
}

// Pairs a transcript bang output with the latest command still lacking one.
function attachBangOutput(msgs: Msg[], d: { stdout: string; stderr: string }) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'bang' && !m.result) { msgs[i] = { ...m, result: { stdout: d.stdout, stderr: d.stderr } }; return; }
  }
}

function applyDeltas(prev: Msg[], deltas: Delta[]): Msg[] {
  let arr = prev;
  for (const d of deltas) {
    if (d.kind === 'append') arr = [...arr, d.msg];
    else if (d.kind === 'bang_output') { arr = [...arr]; attachBangOutput(arr, d); }
    else arr = arr.map((m) => (m.role === 'tool' && m.toolUseId === d.toolUseId && m.output === undefined ? { ...m, output: d.output, outputImages: d.images, doneAt: d.at } : m));
  }
  return arr;
}

// ----- small presentational helpers --------------------------------------

// Model: web.BangCommand — one `!` command: the command line, its state and
// output. Long output scrolls inside the block.
export function BangBlock({ msg, onInterrupt }: { msg: Msg & { role: 'bang' }; onInterrupt?: () => void }) {
  const r = msg.result;
  const running = !r;
  let state: string;
  let tone = '';
  if (!r) state = 'running…';
  else if (r.blocked) { state = `blocked — ${r.blocked}`; tone = ' bad'; }
  else if (r.timedOut) { state = 'timed out'; tone = ' bad'; }
  else if (r.interrupted) { state = 'interrupted'; tone = ' bad'; }
  else if (r.code != null && r.code !== 0) { state = `exit ${r.code}`; tone = ' bad'; }
  else state = r.code === 0 ? 'exit 0' : '';
  const output = r ? [r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? '\n' : '') : '';
  return (
    <div className={`msg msg-bang${running ? ' running' : ''}`}>
      <div className="bang-head">
        <span className="bang-prompt">!</span>
        <code className="bang-command">{msg.command}</code>
        {state && <span className={`bang-state${tone}`}>{state}</span>}
        {running && onInterrupt && <button type="button" className="bang-stop" onClick={onInterrupt}>Stop</button>}
      </div>
      {output && <pre className="bang-output">{output}</pre>}
      {msg.pending && r && <div className="bang-note">Claude will see this with your next message</div>}
    </div>
  );
}

export const MarkdownText = memo(function MarkdownText({ text, theme, projectPath, onOpenFile }: {
  text: string;
  theme: Theme;
  projectPath?: string;
  onOpenFile?: (relPath: string) => void;
}) {
  const style = theme === 'light' ? oneLight : vscDarkPlus;
  const codeStyle = { margin: '4px 0', borderRadius: 4, fontSize: 11, padding: '6px 8px' };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) { return <MarkdownLink {...props} projectPath={projectPath} onOpenFile={onOpenFile} />; },
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!match) return <code className={className} {...props}>{children}</code>;
          return (
            <SyntaxHighlighter PreTag="div" language={match[1]} style={style as any} customStyle={codeStyle}>
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          );
        },
      }}
    >
      {stripStatus(text)}
    </ReactMarkdown>
  );
});

export function ToolFields({ input, rel }: { input: any; rel: (s: string) => string }) {
  if (!input || typeof input !== 'object') return <pre className="tool-field-value">{String(input ?? '')}</pre>;
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className="tool-field">
          <div className="tool-field-key">{k}</div>
          <pre className="tool-field-value">{typeof v === 'string' ? rel(v) : JSON.stringify(v, null, 2)}</pre>
        </div>
      ))}
    </>
  );
}

export function summarizeTool(name: string, input: any, rel: (s: string) => string): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (keys: string[]) => {
    for (const k of keys) { const v = input[k]; if (typeof v === 'string' && v) return v; }
    return '';
  };
  let s = '';
  switch (name) {
    case 'Bash': s = pick(['description', 'command']); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick(['file_path', 'notebook_path']); break;
    case 'Glob': case 'Grep': s = pick(['pattern']); break;
    case 'WebFetch': s = pick(['url']); break;
    case 'WebSearch': s = pick(['query']); break;
    case 'Task': case 'Agent': s = pick(['description', 'prompt']); break;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': s = planToolSummary(name, input); break;
    case 'AskUserQuestion': s = Array.isArray(input.questions) ? input.questions.map((q: any) => q?.header || '').filter(Boolean).join(', ') : ''; break;
    default: s = pick(['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']);
  }
  s = rel(s).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

function sendKeyHint(k: SendKey): string {
  switch (k) {
    case 'cmd-enter': return 'Ask Claude (SDK)… (⌘/Ctrl+Enter to send · !cmd runs a shell command)';
    case 'shift-enter': return 'Ask Claude (SDK)… (Shift+Enter to send · !cmd runs a shell command)';
    case 'enter': return 'Ask Claude (SDK)… (Enter to send · !cmd runs a shell command)';
  }
}

type Catalog = {
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
  agents: string[];
  models: Array<{ value: string; displayName: string; description?: string }>;
};

// ----- the panel ----------------------------------------------------------

export function SdkPanel({
  projectId,
  projectPath,
  resumeId,
  wire,
  parentSessionId,
  worktree,
  initialPrompt,
  sendKey,
  theme,
  showStderr,
  richCopy,
  onTitle,
  onSessionId,
  onInitialPromptConsumed,
  onOpenFile,
  onActivity,
  onBtw,
  onSideChatAbout,
  onOpenProgress,
  onShowPreview,
  onOpenSession,
  onExportApi,
  onComment,
  commentMarks,
  onBookmark,
  bookmarkedAnchors,
  onFocusComment,
  onBatchSent,
  onPanelApi,
}: {
  projectId: string;
  projectPath?: string;
  resumeId?: string;
  // Model: Tab.wire / web.WireCaptureSession — sent as wire=1 on every
  // handshake so the server routes this session through its wire proxy.
  wire?: boolean;
  // Model: Session.parent — sent as parent=<id> on a fresh session's handshake
  // so the server files it under that session in the Sessions tree.
  parentSessionId?: string;
  // Model: Session.worktree — a fresh session starts in this worktree of the
  // project (sent as worktree=<name> on the handshake).
  worktree?: string;
  // One-shot first message for a fresh session (Tab.initialPrompt); never on resume.
  initialPrompt?: string;
  sendKey: SendKey;
  theme: Theme;
  showStderr?: boolean;
  richCopy?: boolean;
  onTitle?: (title: string) => void;
  onSessionId?: (uuid: string) => void;
  onInitialPromptConsumed?: () => void;
  onOpenFile?: (relPath: string) => void;
  onActivity?: (a: TabActivity | null) => void;
  // Model: SideChat — `/btw …` opens the side chat about this session; false when it has no id yet.
  onBtw?: (question: string) => boolean;
  // Model: web.MessageActions — a side chat about one message (quoted); false when the session has no id yet.
  onSideChatAbout?: (quote: string) => boolean;
  // Model: web.PlanStrip — open the Progress tab beside the chat.
  onOpenProgress?: () => void;
  // Model: web.PreviewView — Claude's show_preview opens a page in the side panel.
  onShowPreview?: (port: number, path: string) => void;
  // Open one of this project's sessions in its own tab (a child session).
  onOpenSession?: (sessionId: string, title?: string) => void;
  onExportApi?: (api: { open: () => void; canExport: boolean } | null) => void;
  // Review integration — same contract as ChatPanel (omitted when settings.review is off).
  onComment?: (c: NewComment) => string | null;
  // Model: web.BookmarkMessage — ☆ toggle on a message; returns a status to
  // toast or null. Omitted when settings.review is off.
  onBookmark?: (b: NewBookmark) => string | null;
  // Anchors already bookmarked in this session (rendered as ★).
  bookmarkedAnchors?: ReadonlySet<string>;
  commentMarks?: readonly CommentMark[];
  onFocusComment?: (commentId: string) => void;
  onBatchSent?: (batchId: string) => void;
  onPanelApi?: (api: SessionPanelApi | null) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // Model: web.HistoryNotice — why the history is missing, instead of a blank chat.
  const [historyError, setHistoryError] = useState<string | null>(null);
  const msgsRef = useRef<Msg[]>(msgs);
  msgsRef.current = msgs;
  const [status, setStatus] = useState<Status>('connecting');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toolPopout, setToolPopout] = useState<Msg | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // The session is compacting its conversation (SDK status event).
  const [compacting, setCompacting] = useState(false);
  const compactedRef = useRef(false);
  const [oldestIdx, setOldestIdx] = useState(0);
  // Model: web.PlanStrip — plan tool calls from the transcript before oldestIdx.
  const [planBefore, setPlanBefore] = useState<PlanToolCall[]>([]);
  const plan = useMemo(
    () => foldPlan([...planBefore, ...msgs.flatMap((m) => m.role === 'tool' && isPlanTool(m.name) ? [{ name: m.name, input: m.input, output: m.output }] : [])]),
    [planBefore, msgs],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Model: Session.mode — bypass or plan, and the plan waiting for approval.
  const [mode, setMode] = useState<SessionMode>('bypassPermissions');
  const [modePickerOpen, setModePickerOpen] = useState(false);
  const [planAsk, setPlanAsk] = useState<{ id: string; plan: string } | null>(null);
  // Tool calls waiting for the user's leave (acceptEdits / auto).
  const [permAsks, setPermAsks] = useState<PermissionAsk[]>([]);
  // Model: Session.queue — kept by the server, mirrored here.
  const [queued, setQueued] = useState<QueuedView[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [wireOn, setWireOn] = useState(false);
  // Context window reading, pushed by the server after each turn.
  const [contextUsage, setContextUsage] = useState<ContextSnapshot | null>(null);
  // Model: Session.watches — what the server watches for on this session's behalf.
  const [watches, setWatches] = useState<WatchItem[]>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [insertion, setInsertion] = useState<PromptInsertion | null>(null);
  const pendingInitialPromptRef = useRef<string | null>(initialPrompt?.trim() || null);
  const oldestIdxRef = useRef(0);
  const statusRef = useRef<Status>('connecting');
  const wireRef = useRef(!!wire); wireRef.current = !!wire;
  const parentRef = useRef(parentSessionId); parentRef.current = parentSessionId;
  const worktreeRef = useRef(worktree); worktreeRef.current = worktree;
  // Model: web.NewChildSession "Includes context from parent". A fresh child
  // the user opened gets a summary of its parent, attached ahead of the
  // first message unless dismissed.
  type ParentCtx = { status: 'loading' } | { status: 'ready'; ctx: ParentContext } | { status: 'error'; message: string } | { status: 'off' };
  const [parentCtx, setParentCtx] = useState<ParentCtx>(() => (parentSessionId && !resumeId ? { status: 'loading' } : { status: 'off' }));
  const parentCtxRef = useRef(parentCtx); parentCtxRef.current = parentCtx;
  const parentCtxPromise = useRef<Promise<void> | null>(null);
  const [parentCtxOpen, setParentCtxOpen] = useState(false);
  useEffect(() => {
    if (!parentSessionId || resumeId) return;
    let gone = false;
    parentCtxPromise.current = summarizeSession(projectId, parentSessionId).then(
      (r) => { if (!gone && parentCtxRef.current.status === 'loading') setParentCtx({ status: 'ready', ctx: { title: r.title, summary: r.summary } }); },
      (e) => { if (!gone && parentCtxRef.current.status === 'loading') setParentCtx({ status: 'error', message: (e as Error).message }); },
    );
    return () => { gone = true; };
    // Once per mount: a tab is one child of one parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The worktree the session actually runs in, as the server reports it.
  const [worktreeName, setWorktreeName] = useState<string | null>(null);
  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [rewinding, setRewinding] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadOlderRef = useRef<HTMLButtonElement | null>(null);
  const stickyBottomRef = useRef(true);
  const beforePrependRef = useRef<{ height: number; top: number } | null>(null);
  const loadingMoreRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  oldestIdxRef.current = oldestIdx;
  statusRef.current = status;

  const wsRef = useRef<DuplexSocket | null>(null);
  // Model: web.WorkGroups "working in the background" — the session's commands and subagents still running.
  const [bgTasks, setBgTasks] = useState<Array<{ taskId: string; description: string; subagent: boolean }>>([]);
  const activeSessionIdRef = useRef<string | null>(resumeId ?? null);
  const closedByUsRef = useRef(false);
  const sessionExitedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // Give up after this many connects that never reached `started` (parity
  // with ChatPanel): a dead server shouldn't keep a tab retrying forever.
  const failedConnectsRef = useRef(0);
  const gotStartedRef = useRef(false);
  const MAX_FAILED_CONNECTS = 3;
  const lastMessageAtRef = useRef(Date.now());
  const heartbeatTimerRef = useRef<number | null>(null);
  const PING_INTERVAL_MS = 25_000;
  const HEARTBEAT_DEAD_MS = 60_000;
  const VISIBILITY_STALE_MS = 30_000;

  // Streaming bookkeeping (rule-369): text/tool blocks created from
  // stream_event, matched to the complete `assistant` echo by message.id.
  const orphanResultsRef = useRef(new Map<string, ToolOutput>());
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamedAssistantIdsRef = useRef(new Set<string>());
  const streamBlocksRef = useRef(new Map<string, { ourMsgId: string; kind: 'text' | 'tool_use' | 'thinking'; jsonBuf?: string; uuidAssigned?: boolean; startedAt?: number }>());

  // Latest callbacks for the mount-time WS handlers.
  const onTitleRef = useRef(onTitle); onTitleRef.current = onTitle;
  const onShowPreviewRef = useRef(onShowPreview); onShowPreviewRef.current = onShowPreview;
  const onSessionIdRef = useRef(onSessionId); onSessionIdRef.current = onSessionId;
  const onActivityRef = useRef(onActivity); onActivityRef.current = onActivity;
  const onOpenFileRef = useRef(onOpenFile); onOpenFileRef.current = onOpenFile;
  const openFile = useCallback((p: string) => onOpenFileRef.current?.(p), []);
  const showStderrRef = useRef(showStderr); showStderrRef.current = showStderr;

  const rel = useMemo(() => makeRelPath(projectPath), [projectPath]);
  const attachments = useImageAttachments();
  const pendingImages = attachments.images;
  const modelCatalog = useClaudeModels();
  const { skills: aieSkills, agents: aieAgents, refresh: refreshCommands } = useAieCommands(projectId);
  const cliCatalog = useMemo<ClaudeCliCatalog | null>(
    () => (catalog ? { slashCommands: catalog.commands.map((c) => c.name), skills: [], agents: catalog.agents, terminalSlashCommands: [] } : null),
    [catalog],
  );
  const commands = useMemo(() => [BTW_COMMAND, ...toCommandItems(aieSkills, aieAgents, cliCatalog)], [aieSkills, aieAgents, cliCatalog]);

  // Export (⋮ → Export session). Same stale-closure note as ChatPanel: App
  // hands a fresh arrow per render, the underlying registerExportApi is stable.
  useEffect(() => {
    if (!onExportApi) return;
    onExportApi({ open: () => setExportOpen(true), canExport: msgs.length > 0 });
    return () => onExportApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);
  useEffect(() => {
    if (!onPanelApi) return;
    onPanelApi({
      reveal,
      insertPrompt: (text, batchId) => setInsertion((prev) => ({ seq: (prev?.seq ?? 0) + 1, text, batchId })),
      addQuotes: (quotes: ChatQuote[]) => setInsertion((prev) => ({ seq: (prev?.seq ?? 0) + 1, text: '', quotes })),
    });
    return () => onPanelApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Review (model: web.CommentOnSelection / HighlightQuotes) — only when enabled.
  const canComment = !!onComment;
  // Model: web.BookmarkMessage — ☆ only when Review is on (builtinTabKinds
  // omits onBookmark otherwise).
  const canBookmark = !!onBookmark;
  function bookmark(anchor: string, text: string) {
    const note = onBookmark?.({ anchor, label: bookmarkLabel(text) });
    if (note) showToast(note);
  }
  const commentedAnchors = useMemo(() => new Set((commentMarks ?? []).map((m) => m.anchor)), [commentMarks]);
  const highlightOwner = useRef({}).current;
  useEffect(() => { applyQuoteHighlights(highlightOwner, scrollRef.current, canComment ? commentMarks ?? [] : []); });
  useEffect(() => () => applyQuoteHighlights(highlightOwner, null, []), [highlightOwner]);
  function submitComment(c: NewComment) {
    const note = onComment?.(c);
    if (note) showToast(note);
  }
  // A comment on a passage rides on a quote card (model: web.AddToChat), so
  // the input keeps only what the user types; one without a quote is plain text.
  function sendComment(c: NewComment) {
    setInsertion((prev) => (c.quote
      ? { seq: (prev?.seq ?? 0) + 1, text: '', quotes: [{ quote: c.quote, comment: c.text, origin: 'Claude message' }] }
      : { seq: (prev?.seq ?? 0) + 1, text: composeComment(c) }));
  }
  // Model: web.AddToChat — quote a selected passage as a card on our own input.
  function addToChat(quote: string) {
    setInsertion((prev) => ({ seq: (prev?.seq ?? 0) + 1, text: '', quotes: [{ quote, origin: 'Claude message' }] }));
  }

  // Model: web.MessageActions — on a phone (no hover) a tap on a message shows
  // its row; a tap elsewhere hides it. Taps on links, buttons and form fields
  // are left alone.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !window.matchMedia('(hover: none)').matches) return;
    const onTap = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('a, button, input, textarea, summary, .msg-actions')) return;
      const msg = t.closest<HTMLElement>('.msg-user, .msg-assistant');
      root.querySelectorAll('.msg.actions-on').forEach((el) => { if (el !== msg) el.classList.remove('actions-on'); });
      msg?.classList.toggle('actions-on');
    };
    root.addEventListener('click', onTap);
    return () => root.removeEventListener('click', onTap);
  }, []);

  // Model: web.MessageActions — Copy, Copy link and Side chat over a message.
  async function copyMessage(text: string) {
    showToast((await copyText(text)) ? 'Copied ✓' : 'Copy failed');
  }
  const linkable = (anchor: string | null) => (anchor && activeSessionIdRef.current ? anchor : null);
  async function copyMessageLink(anchor: string) {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const url = messageLink(window.location.origin + window.location.pathname, { projectId, sessionId: sid, anchor });
    showToast((await copyText(url)) ? 'Link copied ✓' : 'Copy failed');
  }
  function sideChatAbout(text: string) {
    if (!onSideChatAbout) return;
    if (!onSideChatAbout(text)) showToast('Send a first message: a side chat needs the session to exist');
  }

  // Model: web.RichCopy — 🍚 on assistant messages when the setting is on.
  const showRichCopy = !!richCopy;
  const { copy: copyRich, source: richCopySource } = useRichCopy(
    (text) => <MarkdownText text={text} theme={theme} projectPath={projectPath} onOpenFile={openFile} />,
    (ok) => showToast(ok ? 'Copied ✓' : 'Copy failed'),
  );

  // Escape closes the lightbox / tool popout (parity with ChatPanel).
  useEffect(() => {
    if (!lightbox && !toolPopout) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setLightbox(null); setToolPopout(null); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox, toolPopout]);

  function showToast(text: string, durationMs = 2500) {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
  }

  function append(m: Msg) { setMsgs((prev) => [...prev, m]); }

  function wsSend(payload: unknown) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  // ----- AskUserQuestion forms (rule-372) --------------------------------
  const toolCards = useMemo(
    () => msgs.flatMap((m) => (m.role === 'tool' && m.toolUseId ? [{ toolCallId: m.toolUseId, rawInput: m.input }] : [])),
    [msgs],
  );
  const forms = useElicitationHost({
    agentName: 'Claude',
    sendKey,
    scrollRef,
    cards: toolCards,
    showToast,
    respond: (req, content) => {
      wsSend(content
        ? { type: 'elicitation_response', id: req.id, action: 'accept', content: claudeAnswersFrom(req, content) }
        : { type: 'elicitation_response', id: req.id, action: 'decline' });
    },
    sendFollowUp: (text, images) => sendPrompt(text, images),
  });

  const generating = status === 'thinking';
  // Model: web.WorkGroups "working in the background" — the turn has ended
  // but commands or subagents it started still run (the CLI hands each one's
  // end back to Claude as a new turn). Still work going on, so the latest
  // group stays open until they are done.
  const inBackground = !generating && bgTasks.length > 0 && (status === 'ready');
  const working = generating || inBackground;
  // Model: web.WorkGroups — the work between messages, folded per stretch.
  const workItems = useMemo(() => groupWork(msgs as WorkMsg[], working) as WorkItem<Msg & WorkMsg>[], [msgs, working]);
  const awaitingInput = forms.elicitations.some((e) => !e.recap) || planAsk !== null || permAsks.length > 0;
  useEffect(() => { onActivityRef.current?.({ generating, awaitingInput }); }, [generating, awaitingInput]);
  useEffect(() => () => onActivityRef.current?.(null), []);

  // ----- transcript ------------------------------------------------------
  async function refetchTranscript(sid: string) {
    let r: Response | null = null;
    const shownBefore = new Set(msgsRef.current.map((m) => m.id));
    try {
      r = await fetch(`/api/projects/${projectId}/sdk-sessions/${sid}/transcript?limit=20`);
      if (!r.ok) {
        logDebug('history', `sdk ${sid.slice(0, 8)}: transcript HTTP ${r.status}`);
        setHistoryError(historyProblem(r, null, null));
        return;
      }
      const { events, startIndex, planTools, total } = await r.json();
      logDebug('history', `sdk ${sid.slice(0, 8)}: ${events?.length ?? 0} of ${total ?? '?'} messages`);
      setHistoryError(historyProblem(r, events?.length ?? 0, total ?? null));
      orphanResultsRef.current = new Map();
      const fetched = buildFromEvents(events, orphanResultsRef.current);
      setMsgs((prev) => withArrivedDuring(fetched, prev, shownBefore));
      setOldestIdx(startIndex ?? 0);
      setPlanBefore(Array.isArray(planTools) ? planTools : []);
    } catch (e) {
      logDebug('history', `sdk ${sid.slice(0, 8)}: transcript failed: ${String(e)}`);
      if (!r) setHistoryError(historyProblem(null, null, null));
    }
  }

  function loadOlder() { return loadOlderFrom(oldestIdxRef.current); }

  async function loadOlderFrom(before: number) {
    const sid = activeSessionIdRef.current;
    if (!sid || loadingMoreRef.current || before <= 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/sdk-sessions/${sid}/transcript?before=${before}&limit=20`);
      if (!r.ok) return;
      const { events, startIndex, planTools } = await r.json();
      const el = scrollRef.current;
      if (el) beforePrependRef.current = { height: el.scrollHeight, top: el.scrollTop };
      const older = buildFromEvents(events, orphanResultsRef.current);
      setMsgs((prev) => [...older, ...prev]);
      setOldestIdx(startIndex ?? 0);
      setPlanBefore(Array.isArray(planTools) ? planTools : []);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  // Model: web.RevealMessage — scroll the anchored message into view, paging
  // back until it turns up; false = not in this session.
  async function reveal(anchor: string): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      const root = scrollRef.current;
      const visible = !!root && root.clientHeight > 0;
      const el = root?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`) ?? null;
      if (el && visible) {
        el.scrollIntoView({ block: 'center' });
        flashMessage(el);
        return true;
      }
      const busy = loadingMoreRef.current || statusRef.current === 'connecting' || statusRef.current === 'replaying';
      if (!visible || busy) { await sleep(150); continue; }
      if (oldestIdxRef.current > 0) {
        await loadOlderFrom(oldestIdxRef.current);
        await sleep(50);
        continue;
      }
      return false;
    }
    return false;
  }

  // ----- WS lifecycle (rule-368 / rule-376) ------------------------------
  useEffect(() => {
    let aborted = false;
    closedByUsRef.current = false;
    sessionExitedRef.current = false;

    function openWs() {
      if (aborted || closedByUsRef.current) return;
      const params = new URLSearchParams({ project: projectId });
      const sid = activeSessionIdRef.current;
      if (sid) params.set('resume', sid);
      else {
        if (parentRef.current) params.set('parent', parentRef.current);
        if (worktreeRef.current) params.set('worktree', worktreeRef.current);
      }
      if (wireRef.current) params.set('wire', '1');
      const ws = openDuplex('sdk-session', params);
      wsRef.current = ws;
      gotStartedRef.current = false;
      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        lastMessageAtRef.current = Date.now();
        if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = window.setInterval(() => {
          if (Date.now() - lastMessageAtRef.current > HEARTBEAT_DEAD_MS) { try { ws.close(); } catch {} return; }
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (ev) => {
        lastMessageAtRef.current = Date.now();
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        handleWsMsg(data);
      };
      ws.onclose = () => {
        if (heartbeatTimerRef.current) { window.clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
        if (wsRef.current === ws) wsRef.current = null;
        if (aborted || closedByUsRef.current || sessionExitedRef.current) { if (!sessionExitedRef.current) setStatus('closed'); return; }
        if (!gotStartedRef.current) {
          failedConnectsRef.current++;
          if (failedConnectsRef.current >= MAX_FAILED_CONNECTS) {
            append({ id: shortId(), role: 'system', text: 'Could not reach the session — refresh the tab (↻) to retry.' });
            setStatus('closed');
            return;
          }
        } else {
          failedConnectsRef.current = 0;
        }
        scheduleReconnect();
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    function scheduleReconnect() {
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      setStatus('reconnecting');
      reconnectTimerRef.current = window.setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (aborted) return;
        const sid = activeSessionIdRef.current;
        if (sid) await refetchTranscript(sid);
        if (aborted) return;
        openWs();
      }, delay);
    }

    async function start() {
      const sid = activeSessionIdRef.current;
      if (sid) {
        setStatus('replaying');
        await refetchTranscript(sid);
        if (aborted) return;
      }
      openWs();
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || sessionExitedRef.current) return;
      const stale = Date.now() - lastMessageAtRef.current > VISIBILITY_STALE_MS;
      if (stale || ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch {} }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    void start();
    return () => {
      aborted = true;
      closedByUsRef.current = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Read through refs by the mount-time handlers above.
  const handleWsMsgRef = useRef<(m: any) => void>(() => {});
  function handleWsMsg(m: any) { handleWsMsgRef.current(m); }
  handleWsMsgRef.current = (m: any) => {
    if (m.type === 'pong') return;
    if (m.type === 'bg_tasks') { setBgTasks(Array.isArray(m.running) ? m.running : []); return; }
    if (m.type === 'started') {
      gotStartedRef.current = true;
      failedConnectsRef.current = 0;
      if (m.resumed) pendingInitialPromptRef.current = null;
      setStatus(m.thinking ? 'thinking' : 'ready');
      setBgTasks(Array.isArray(m.bgTasks) ? m.bgTasks : []);
      setCompacting(m.compacting === true);
      if (typeof m.sessionId === 'string' && m.sessionId) {
        activeSessionIdRef.current = m.sessionId;
        onSessionIdRef.current?.(m.sessionId);
      }
      if (isSessionMode(m.mode)) setMode(m.mode);
      setPlanAsk(null); // a pending one is re-sent right after this frame
      setPermAsks([]);
      if (m.model) setModel(m.model);
      else if (m.requestedModel) setModel((cur) => cur ?? m.requestedModel);
      if (typeof m.effort === 'string') setEffort(m.effort);
      setWireOn(m.wire === true);
      setWorktreeName(typeof m.worktree === 'string' && m.worktree ? m.worktree : null);
      setContextUsage(m.context ?? null);
      setQueued(parseQueue(m.queue));
      if (typeof m.title === 'string' && m.title) onTitleRef.current?.(m.title);
      if (Array.isArray(m.commands)) setCatalog({ commands: m.commands, agents: m.agents ?? [], models: m.models ?? [] });
      showToast(m.resumed ? (m.attached ? 'Attached to live session' : 'Resumed session') : 'Session started');
      // Model: web.HistoryNotice — a resumed session with nothing on screen
      // most likely asked for its history too early: ask once more.
      const resumedSid = activeSessionIdRef.current;
      if (m.resumed && resumedSid && msgsRef.current.length === 0) {
        window.setTimeout(() => { if (msgsRef.current.length === 0) void refetchTranscript(resumedSid); }, 1000);
      }
      return;
    }
    if (m.type === 'context') { if (m.context) setContextUsage(m.context); return; }
    if (m.type === 'watches') { setWatches(Array.isArray(m.items) ? m.items : []); return; }
    if (m.type === 'queue') { setQueued(parseQueue(m.items)); return; }
    if (m.type === 'catalog') { setCatalog({ commands: m.commands ?? [], agents: m.agents ?? [], models: m.models ?? [] }); return; }
    if (m.type === 'title') { if (typeof m.title === 'string' && m.title) onTitleRef.current?.(m.title); return; }
    if (m.type === 'side_open') {
      const w = m.want;
      if (w?.kind === 'preview' && Number.isInteger(w.port) && w.port >= 1024 && w.port <= 65535) onShowPreviewRef.current?.(w.port, typeof w.path === 'string' && w.path.startsWith('/') ? w.path : '/');
      return;
    }
    if (m.type === 'model') { if (typeof m.model === 'string') setModel(m.model); return; }
    if (m.type === 'effort') { const lvl = typeof m.effort === 'string' ? m.effort : ''; setEffort(lvl); showToast(lvl ? `Effort: ${lvl}` : 'Effort: default'); return; }
    if (m.type === 'effort_error' || m.type === 'rewind_error') { showToast(String(m.message ?? 'Request failed')); setRewinding(false); return; }
    if (m.type === 'stderr') {
      const text = String(m.data ?? '');
      if (showStderrRef.current || /^(ERROR|PANIC)/i.test(text)) append({ id: shortId(), role: 'system', text: `[stderr] ${text.trim()}` });
      return;
    }
    if (m.type === 'error') { append({ id: shortId(), role: 'system', text: `error: ${m.message}` }); return; }
    if (m.type === 'external_change') {
      showToast('External change detected, refreshing');
      if (activeSessionIdRef.current) void refetchTranscript(activeSessionIdRef.current);
      return;
    }
    if (m.type === 'exit') {
      sessionExitedRef.current = true;
      append({ id: shortId(), role: 'system', text: m.code === 'open-elsewhere' ? 'This session is open in another tab — closed here.' : 'session exited' });
      setStatus('closed');
      forms.clear();
      return;
    }
    if (m.type === 'user_echo') {
      // rule-370: our own (or another client's) prompt with its jsonl uuid.
      const deltas = renderEvent({ type: 'user', uuid: m.uuid, message: m.message });
      const bubble = deltas.find((d): d is Extract<Delta, { kind: 'append' }> => d.kind === 'append' && d.msg.role === 'user');
      if (!bubble) return;
      const msgId = typeof m.msgId === 'string' ? m.msgId : null;
      // This prompt carried every finished `!` command along (server side).
      const carriedBang = deltas.some((d) => d.kind === 'append' && d.msg.role === 'bang');
      setMsgs((prev0) => {
        const prev = carriedBang ? prev0.map((x) => (x.role === 'bang' && x.pending && x.result ? { ...x, pending: false } : x)) : prev0;
        if (msgId && prev.some((x) => x.role === 'user' && x.id === msgId)) {
          return prev.map((x) => (x.role === 'user' && x.id === msgId ? { ...x, uuid: m.uuid } : x));
        }
        return [...prev, bubble.msg];
      });
      setStatus('thinking');
      return;
    }
    if (m.type === 'bang_start') { upsertBang(String(m.id), { command: String(m.command ?? '') }); return; }
    if (m.type === 'bang_result') { upsertBang(String(m.id), { command: String(m.result?.command ?? ''), result: m.result }); return; }
    if (m.type === 'bang_state') {
      for (const r of m.running ?? []) upsertBang(String(r.id), { command: String(r.command ?? '') });
      for (const p of m.pending ?? []) upsertBang(String(p.id), { command: String(p.result?.command ?? ''), result: p.result });
      return;
    }
    if (m.type === 'ask') {
      const req = parseAskUserQuestion(m.data);
      if (req) forms.add(req);
      return;
    }
    if (m.type === 'permission_mode') { if (isSessionMode(m.mode)) setMode(m.mode); return; }
    if (m.type === 'plan_ask') { setPlanAsk({ id: String(m.id), plan: typeof m.plan === 'string' ? m.plan : '' }); return; }
    if (m.type === 'plan_done') { setPlanAsk((cur) => (cur?.id === m.id ? null : cur)); return; }
    if (m.type === 'permission_ask') { const a = parsePermissionAsk(m); if (a) setPermAsks((cur) => addPermissionAsk(cur, a)); return; }
    if (m.type === 'permission_done') { setPermAsks((cur) => cur.filter((a) => a.id !== m.id)); return; }
    if (m.type === 'ask_timeout' || m.type === 'ask_cancel') {
      setPlanAsk((cur) => (cur?.id === m.id ? null : cur));
      setPermAsks((cur) => cur.filter((a) => a.id !== m.id));
    }
    if (m.type === 'ask_timeout') { forms.expire(m.id); return; }
    if (m.type === 'ask_cancel' || m.type === 'ask_done') { forms.settle(m.id, m.type === 'ask_done' ? 'Answered' : 'Cancelled'); return; }
    if (m.type === 'rewound') {
      currentAssistantIdRef.current = null;
      streamBlocksRef.current.clear();
      orphanResultsRef.current = new Map();
      setMsgs([]);
      forms.clear();
      setRewinding(false);
      setEditingUuid(null);
      setEditingText('');
      setStatus('thinking');
      if (typeof m.sessionId === 'string' && m.sessionId) {
        activeSessionIdRef.current = m.sessionId;
        onSessionIdRef.current?.(m.sessionId);
        void refetchTranscript(m.sessionId);
      }
      return;
    }
    if (m.type !== 'message') return;
    const ev = m.data;
    if (ev?.type === 'stream_event') { processStreamEvent(ev.event); return; }
    if (ev?.type === 'system' && ev.subtype === 'init') {
      if (ev.model) setModel(ev.model);
      if (typeof ev.session_id === 'string' && ev.session_id) {
        activeSessionIdRef.current = ev.session_id;
        onSessionIdRef.current?.(ev.session_id);
      }
      return;
    }
    if (ev?.type === 'system' && ev.subtype === 'status') {
      setCompacting(ev.status === 'compacting');
      if (ev.compact_result === 'success') compactedRef.current = true;
      return;
    }
    if (ev?.type === 'result') {
      setCompacting(false);
      setStatus('ready');
      // A compaction rewrote the conversation: show what it is now (its
      // records are all written by the time its result arrives).
      if (compactedRef.current) {
        compactedRef.current = false;
        if (activeSessionIdRef.current) void refetchTranscript(activeSessionIdRef.current);
      }
      refreshClaudeUsage(); // a turn just spent quota; server cache caps this at 1/min
      currentAssistantIdRef.current = null;
      return;
    }
    if (ev?.type === 'assistant' && ev.message?.id && streamedAssistantIdsRef.current.has(ev.message.id)) {
      patchStreamedUuid(ev.message.id, ev.uuid, ev.message.content);
      return;
    }
    if (ev?.type === 'assistant' || ev?.type === 'user') {
      setMsgs((prev) => applyDeltas(prev, renderEvent(ev)));
    }
  };

  // ----- streaming (rule-369) --------------------------------------------
  function blockKey(assistantId: string, idx: number) { return `${assistantId}#${idx}`; }

  function patchStreamedUuid(assistantId: string, uuid: unknown, content: unknown) {
    if (typeof uuid !== 'string') return;
    const streamedText = [...streamBlocksRef.current.entries()]
      .filter(([k, b]) => k.startsWith(`${assistantId}#`) && b.kind === 'text')
      .sort((a, b) => Number(a[0].split('#')[1]) - Number(b[0].split('#')[1]))
      .map(([, b]) => b);
    (Array.isArray(content) ? content : []).forEach((block: any, blockIdx: number) => {
      if (block?.type !== 'text') return;
      const blk = streamedText.find((b) => !b.uuidAssigned);
      if (!blk) return;
      blk.uuidAssigned = true;
      setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, uuid, blockIdx } : m)));
    });
  }

  function processStreamEvent(streamEv: any) {
    const t = streamEv?.type;
    if (t === 'message_start') {
      const msgId = streamEv.message?.id;
      if (msgId) {
        currentAssistantIdRef.current = msgId;
        for (const k of [...streamBlocksRef.current.keys()]) if (!k.startsWith(`${msgId}#`)) streamBlocksRef.current.delete(k);
        const set = streamedAssistantIdsRef.current;
        set.add(msgId);
        if (set.size > 256) { const first = set.values().next().value; if (first !== undefined) set.delete(first); }
        setStatus('thinking');
      }
      return;
    }
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    if (t === 'content_block_start') {
      const idx: number = streamEv.index;
      const cb = streamEv.content_block;
      const ourMsgId = shortId();
      const now = Date.now();
      if (cb?.type === 'text') {
        streamBlocksRef.current.set(blockKey(assistantId, idx), { ourMsgId, kind: 'text' });
        setMsgs((prev) => [...prev, { id: ourMsgId, role: 'assistant', text: cb.text ?? '', at: now }]);
      } else if (cb?.type === 'thinking' || cb?.type === 'redacted_thinking') {
        streamBlocksRef.current.set(blockKey(assistantId, idx), { ourMsgId, kind: 'thinking', startedAt: now });
        setMsgs((prev) => [...prev, { id: ourMsgId, role: 'thinking', text: typeof cb.thinking === 'string' ? cb.thinking : '', at: now }]);
      } else if (cb?.type === 'tool_use') {
        streamBlocksRef.current.set(blockKey(assistantId, idx), { ourMsgId, kind: 'tool_use', jsonBuf: '' });
        setMsgs((prev) => [...prev, { id: ourMsgId, role: 'tool', name: cb.name, input: {}, toolUseId: cb.id, at: now, step: assistantId }]);
      }
      return;
    }
    if (t === 'content_block_delta') {
      const blk = streamBlocksRef.current.get(blockKey(assistantId, streamEv.index));
      if (!blk) return;
      const delta = streamEv.delta;
      if (delta?.type === 'text_delta' && blk.kind === 'text') {
        const piece: string = delta.text ?? '';
        setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, text: m.text + piece } : m)));
      } else if (delta?.type === 'thinking_delta' && blk.kind === 'thinking') {
        const piece: string = delta.thinking ?? '';
        if (piece) setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'thinking' ? { ...m, text: m.text + piece } : m)));
      } else if (delta?.type === 'input_json_delta' && blk.kind === 'tool_use') {
        blk.jsonBuf = (blk.jsonBuf ?? '') + (delta.partial_json ?? '');
      }
      return;
    }
    if (t === 'content_block_stop') {
      const key = blockKey(assistantId, streamEv.index);
      const blk = streamBlocksRef.current.get(key);
      if (!blk) return;
      if (blk.kind === 'thinking') {
        const ms = Date.now() - (blk.startedAt ?? Date.now());
        setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'thinking' ? { ...m, ms } : m)));
        streamBlocksRef.current.delete(key);
      } else if (blk.kind === 'tool_use') {
        if (blk.jsonBuf) {
          try {
            const parsed = JSON.parse(blk.jsonBuf);
            setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'tool' ? { ...m, input: parsed } : m)));
          } catch {}
        }
        streamBlocksRef.current.delete(key);
      }
      return;
    }
    if (t === 'message_stop') currentAssistantIdRef.current = null;
  }

  // ----- sending (rule-371) ----------------------------------------------
  // Model: web.FileAttachments — files picked with ＋ or pasted: images ride
  // in the message itself, everything else is uploaded and named by path.
  const fileAttachments = useFileAttachments(projectId, showToast);
  function addAnyFiles(picked: FileList | File[]) {
    const all = Array.from(picked);
    const images = all.filter((f) => f.type.startsWith('image/'));
    const others = all.filter((f) => !f.type.startsWith('image/'));
    if (images.length) attachments.addFiles(images);
    if (others.length) fileAttachments.addFiles(others);
  }

  function sendPrompt(text: string, images: readonly ImageAttachment[], mode: SendMode = 'now') {
    const msgId = shortId();
    // A slash command written during a turn runs only once the turn has
    // ended: queue it, where it shows and can be dropped, rather than let it
    // wait unseen.
    if (mode === 'now' && statusRef.current === 'thinking' && isSlashCommand(text)) mode = 'queue';
    // Model: Session.queue — during a turn, "queue" and "interrupt" wait on
    // the server, shown above the input: until the turn ends, or until the
    // stop the server asks for lands. The server decides: an open question
    // or form takes it as the answer instead, echoed as usual.
    if (mode !== 'now' && statusRef.current === 'thinking') {
      if (!wsSend({ type: 'user', text, images: toWireImages(images), msgId, mode })) showToast('Not connected — message not sent');
      else if (mode === 'interrupt') showToast(isCompactCommand(text) ? 'Stopping Claude — it compacts, then carries on' : 'Stopping Claude — your message goes out as soon as it has stopped');
      return;
    }
    append({ id: msgId, role: 'user', text, images: images.length ? images.map((p) => p.dataUrl) : undefined, at: Date.now() });
    wsSend({ type: 'user', text, images: toWireImages(images), msgId });
    setStatus('thinking');
  }

  // Model: web.BangCommand — add or update a `!` command block by its id.
  function upsertBang(bangId: string, patch: { command: string; result?: BangOutcome }) {
    setMsgs((prev) => {
      const i = prev.findIndex((x) => x.role === 'bang' && x.bangId === bangId);
      if (i < 0) return [...prev, { id: shortId(), role: 'bang', bangId, command: patch.command, result: patch.result, pending: true }];
      const cur = prev[i] as Msg & { role: 'bang' };
      const next = [...prev];
      next[i] = { ...cur, command: patch.command || cur.command, result: patch.result ?? cur.result };
      return next;
    });
  }

  function runBangCommand(command: string) {
    const bangId = shortId();
    if (!wsSend({ type: 'bang', id: bangId, command })) { showToast('Not connected — command not run'); return; }
    upsertBang(bangId, { command });
  }

  function send(raw: string, mode?: SendMode) {
    if (!wsRef.current || status === 'closed' || status === 'connecting' || status === 'reconnecting') return;
    // Model: SideChat — a side question, not a message to this session.
    const btw = btwQuestion(raw);
    if (btw !== null) {
      if (!onBtw) showToast('Side chats are not available here');
      else if (!onBtw(btw)) showToast('Send a first message: a side chat needs the session to exist');
      return;
    }
    if (isBangInput(raw)) {
      const cmd = bangCommand(raw);
      if (cmd) runBangCommand(cmd);
      return;
    }
    const files = fileAttachments.files.filter((f) => f.state === 'ready');
    if (fileAttachments.files.some((f) => f.state === 'uploading')) { showToast('Still uploading the attached files'); return; }
    const text = withAttachedFiles(raw.trim(), files);
    if (!text && pendingImages.length === 0) return;
    const images = pendingImages;
    attachments.clear();
    fileAttachments.clear();
    // The first message of a hand-opened child carries the parent's summary.
    const go = () => {
      const pc = parentCtxRef.current;
      setParentCtx({ status: 'off' });
      sendPrompt(pc.status === 'ready' ? withParentContext(pc.ctx, text) : text, images, mode);
    };
    if (parentCtxRef.current.status === 'loading' && parentCtxPromise.current) {
      showToast('Waiting for the parent summary…');
      void Promise.race([parentCtxPromise.current, new Promise((r) => setTimeout(r, 45_000))]).then(() => setTimeout(go, 0));
    } else go();
  }

  function stop() { wsSend({ type: 'stop' }); }

  // Fire the one-shot initialPrompt once a fresh session is ready (rule-071).
  useEffect(() => {
    if (status !== 'ready') return;
    const text = pendingInitialPromptRef.current;
    if (!text) return;
    pendingInitialPromptRef.current = null;
    send(text);
    onInitialPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function switchMode(next: SessionMode) {
    setModePickerOpen(false);
    if (next === mode) return;
    if (!wsSend({ type: 'set_permission_mode', mode: next })) { showToast('Not connected — mode not changed'); return; }
    setMode(next);
    showToast(`Mode: ${modeInfo(next).label}`);
  }

  function answerPermission(id: string, allow: boolean, remember = false) {
    wsSend({ type: 'permission_response', id, allow, remember });
    setPermAsks((cur) => cur.filter((a) => a.id !== id));
  }

  function answerPlan(approve: boolean) {
    if (!planAsk) return;
    wsSend({ type: 'plan_response', id: planAsk.id, approve });
    setPlanAsk(null);
  }

  function switchModel(alias: string) {
    wsSend({ type: 'set_model', model: alias });
    setModel(alias);
    showToast(`Switching to ${alias}…`);
    setModelPickerOpen(false);
  }

  function switchEffort(level: string) {
    wsSend({ type: 'set_effort', effort: level });
    showToast('Applying effort…');
    setModelPickerOpen(false);
  }

  // ----- rewind (rule-373) -----------------------------------------------
  function startEditUser(m: Msg & { role: 'user' }) {
    if (!m.uuid) return;
    setEditingUuid(m.uuid);
    setEditingText(m.text);
  }
  function cancelEditUser() { setEditingUuid(null); setEditingText(''); }
  function submitRewind(orig: Msg & { role: 'user' }) {
    if (!orig.uuid || rewinding) return;
    const newText = editingText.trim();
    if (!newText) { showToast('Message cannot be empty'); return; }
    const images: { mediaType: string; data: string }[] = [];
    for (const dataUrl of orig.images ?? []) {
      const mm = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (mm) images.push({ mediaType: mm[1], data: mm[2] });
    }
    setRewinding(true);
    if (!wsSend({ type: 'rewind', messageUuid: orig.uuid, newText, images })) { setRewinding(false); showToast('Not connected'); }
  }

  // ----- scrolling -------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (beforePrependRef.current) {
      const { height, top } = beforePrependRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      beforePrependRef.current = null;
      return;
    }
    if (stickyBottomRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [msgs, forms.elicitations]);

  useEffect(() => {
    const el = loadOlderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void loadOlder(); }, { root: scrollRef.current, threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldestIdx, loadingMore]);

  // One tool call as a block (header + detail on click): a question form or
  // plan card in the conversation, or a row opened inside a work group.
  function renderToolBlock(m: Msg & { role: 'tool' }) {
    const anchor = msgAnchor(m);
    const bmCls = canComment && !!anchor && commentedAnchors.has(anchor) ? ' commented' : '';
    const isOpen = expanded.has(m.id);
    const summary = summarizeTool(m.name, m.input, rel);
    const child = onOpenSession ? childLinkOfTool(m.name, m.input, m.output) : null;
    return (
      <div key={m.id} className={`msg msg-tool ${isOpen ? 'open' : ''}${bmCls}`} data-anchor={anchor ?? undefined}>
        <div
          className="tool-header"
          onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; })}
        >
          <span className="tool-chevron">{isOpen ? '▾' : '▸'}</span>
          <span className="tool-name">{m.name}</span>
          {summary && <span className="tool-summary">{summary}</span>}
          {m.output === undefined && <span className="tool-pending">…</span>}
          {child && <button type="button" className="tool-child-open" onClick={(e) => { e.stopPropagation(); onOpenSession!(child.sessionId, child.title); }} title="Open this child session in its own tab">⑂ Open child</button>}
          <ToolCopyButton name={m.name} input={m.input} output={m.output} rel={rel} />
          <button className="tool-popout-btn" onClick={(e) => { e.stopPropagation(); setToolPopout(m); }} title="Open full details" aria-label="Open full details">⛶</button>
        </div>
        {isOpen && (
          <div className="tool-detail">
            <ToolFields input={m.input} rel={rel} />
            {m.output !== undefined && (
              <div className="tool-field">
                <div className="tool-field-key">output</div>
                <pre className="tool-field-value">{rel(m.output)}</pre>
              </div>
            )}
          </div>
        )}
        {m.outputImages && m.outputImages.length > 0 && (
          <div className="tool-images">
            {m.outputImages.map((src, i) => (
              <img key={i} src={src} className="tool-image" alt="" loading="lazy" onClick={() => setLightbox(src)} />
            ))}
          </div>
        )}
        {forms.renderFor(m.toolUseId)}
      </div>
    );
  }

  // A tool call's input and output, opened from its row in a work group.
  function renderToolDetail(m: Msg & { role: 'tool' }) {
    const anchor = msgAnchor(m);
    return (
      <div className="work-detail" data-anchor={anchor ?? undefined}>
        <div className="work-detail-actions">
          <ToolCopyButton name={m.name} input={m.input} output={m.output} rel={rel} />
          <button className="tool-popout-btn" onClick={() => setToolPopout(m)} title="Open full details" aria-label="Open full details">⛶</button>
        </div>
        <ToolFields input={m.input} rel={rel} />
        {m.output !== undefined && (
          <div className="tool-field">
            <div className="tool-field-key">output</div>
            <pre className="tool-field-value">{rel(m.output)}</pre>
          </div>
        )}
      </div>
    );
  }

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  // Model: web.LiveActivity — the newest work group shows its start time, and
  // while Claude works one line at the foot says what it is doing.
  let lastGroupId: string | undefined;
  for (let i = workItems.length - 1; i >= 0; i--) { const it = workItems[i]; if (it.kind === 'group') { lastGroupId = it.id; break; } }
  const waitingOnUser = forms.pendingCount > 0 || permAsks.length > 0 || !!planAsk;
  const activityLine = generating && !waitingOnUser ? liveActivity(plan, msgs, rel) : null;

  // ----- render ----------------------------------------------------------
  return (
    <div className="chat">
      <PlanStrip plan={plan} onOpenSide={onOpenProgress} />
      <div className="chat-messages" ref={scrollRef} onScroll={onMessagesScroll}>
        {historyError && (
          <HistoryNotice text={historyError} onRetry={() => { const sid = activeSessionIdRef.current; if (sid) void refetchTranscript(sid); }} />
        )}
        {oldestIdx > 0 && (
          <button ref={loadOlderRef} className="load-older" onClick={() => void loadOlder()} disabled={loadingMore} type="button">
            {loadingMore ? 'Loading…' : `↑ Load older (${oldestIdx} above)`}
          </button>
        )}
        {workItems.map((item) => {
          if (item.kind === 'group') {
            return (
              <WorkGroupView
                key={item.id}
                group={item}
                latest={item.id === lastGroupId}
                background={item.running && inBackground ? bgTasks.length : 0}
                rel={rel}
                renderDetail={(t) => renderToolDetail(t as Msg & { role: 'tool' })}
                renderForm={(id) => forms.renderFor(id)}
                renderNote={(text) => <MarkdownText text={text} theme={theme} projectPath={projectPath} onOpenFile={openFile} />}
                onOpenChild={onOpenSession ? (t) => { const c = childLinkOfTool(t.name, t.input, t.output); if (c) onOpenSession(c.sessionId, c.title); } : undefined}
                childOf={onOpenSession ? (t) => !!childLinkOfTool(t.name, t.input, t.output) : undefined}
                onImage={setLightbox}
              />
            );
          }
          const m = item.msg;
          const anchor = msgAnchor(m);
          const bmCls = canComment && !!anchor && commentedAnchors.has(anchor) ? ' commented' : '';
          if (m.role === 'user') {
            // A child session's answer, delivered by the server — a report, not a prompt.
            const reports = m.images?.length ? null : parseChildReports(m.text);
            if (reports) {
              return (
                <Fragment key={m.id}>
                  {reports.length > 1 && <div className="msg msg-system" data-anchor={anchor ?? undefined}>{reports.length} child sessions reported together</div>}
                  {reports.map((report, ri) => (
                    <div key={ri} className={`msg msg-child-report${report.ok ? '' : ' failed'}`} data-anchor={reports.length === 1 ? anchor ?? undefined : undefined}>
                      <div className="child-report-head">
                        <span className="child-report-mark" aria-hidden="true">⑂</span>
                        {onOpenSession
                          ? <button type="button" className="child-report-title child-report-open" title="Open this child session" onClick={() => onOpenSession(report.sessionId, report.title)}>{report.title}</button>
                          : <span className="child-report-title">{report.title}</span>}
                        <span className="child-report-state">child session {report.state}</span>
                        {report.intervened && <span className="child-report-flag" title="You typed into this child session during the turn; the parent is told what you said">you stepped in</span>}
                      </div>
                      <MarkdownText text={report.body} theme={theme} projectPath={projectPath} onOpenFile={openFile} />
                    </div>
                  ))}
                </Fragment>
              );
            }
            // A watch the agent set has settled: the server's message, not the user's.
            const watchReport = m.images?.length ? null : parseWatchReport(m.text);
            if (watchReport) {
              return (
                <div key={m.id} className={`msg msg-child-report msg-watch-report${watchReport.state === 'met' ? '' : ' failed'}`} data-anchor={anchor ?? undefined}>
                  <div className="child-report-head">
                    <span className="child-report-mark" aria-hidden="true">⏳</span>
                    <span className="child-report-title">{watchReport.label}</span>
                    <span className="child-report-state">watch {watchReport.state}</span>
                  </div>
                  <MarkdownText text={watchReport.body} theme={theme} projectPath={projectPath} onOpenFile={openFile} />
                </div>
              );
            }
            // Claude Code's word that background tasks ended, one of them not
            // on its own (failed, or cut off when its session ended): a card.
            // Ones that finished are rows of the work group (workGroups.ts).
            const taskNotes = m.images?.length ? null : parseTaskNotifications(m.text);
            if (taskNotes) {
              return (
                <div key={m.id} className={`msg msg-child-report msg-task-note${taskNotes.some((n) => n.status === 'failed') ? ' failed' : taskNotes.some(taskNoteFailed) ? ' cut' : ''}`} data-anchor={anchor ?? undefined}>
                  {taskNotes.map((n, ni) => (
                    <div key={ni} className="task-note">
                      <div className="child-report-head">
                        <span className="child-report-mark" aria-hidden="true">{taskNoteFailed(n) ? '⚠' : n.status === 'completed' ? '✓' : '■'}</span>
                        <span className="child-report-title">{taskNoteTitle(n)}</span>
                        {n.ids.length > 0 && <span className="child-report-state">{n.ids.length === 1 ? `task ${n.ids[0]}` : `${n.ids.length} tasks`}</span>}
                      </div>
                      <div className="task-note-summary">{n.summary}</div>
                      {n.status === 'stopped' && <div className="task-note-hint">Its work may be unfinished: check what it left before relying on it.</div>}
                      {n.result && <MarkdownText text={n.result} theme={theme} projectPath={projectPath} onOpenFile={openFile} />}
                    </div>
                  ))}
                  <details className="task-note-raw">
                    <summary>Notification as sent to Claude</summary>
                    <pre>{m.text}</pre>
                  </details>
                </div>
              );
            }
            // The CLI's record of a stopped turn: a note, not something the user typed.
            if (!m.images?.length && isInterruptNote(m.text)) return <div key={m.id} className="msg msg-system" data-anchor={anchor ?? undefined}>Stopped by the user</div>;
            // What a compaction left behind: not typed by the user.
            const compact = m.images?.length ? null : parseCompactNote(m.text);
            if (compact?.kind === 'done') return null;
            if (compact) {
              return (
                <details key={m.id} className="msg msg-compact" data-anchor={anchor ?? undefined}>
                  <summary>Earlier conversation, compacted into a summary</summary>
                  <div className="msg-compact-body"><MarkdownText text={compact.summary} theme={theme} projectPath={projectPath} onOpenFile={openFile} /></div>
                </details>
              );
            }
            const isEditing = !!m.uuid && editingUuid === m.uuid;
            return (
              <div key={m.id} className={`msg msg-user${bmCls}`} data-anchor={anchor ?? undefined}>
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, i) => <img key={i} src={src} className="msg-image" alt="" onClick={() => setLightbox(src)} />)}
                  </div>
                )}
                {isEditing ? (
                  <div className="msg-user-edit">
                    <textarea
                      className="msg-user-edit-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (isSendKeyTrigger(sendKey, { ...e, isComposing: e.nativeEvent.isComposing })) {
                          e.preventDefault();
                          if (!rewinding && editingText.trim()) submitRewind(m);
                        }
                      }}
                      autoFocus
                      rows={Math.max(2, Math.min(10, editingText.split('\n').length))}
                    />
                    <div className="msg-user-edit-actions">
                      <button type="button" className="msg-user-edit-cancel" onClick={cancelEditUser} disabled={rewinding}>Cancel</button>
                      <button type="button" className="msg-user-edit-send" onClick={() => submitRewind(m)} disabled={rewinding || !editingText.trim()}>
                        {rewinding ? 'Rewinding…' : 'Resend'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {(() => {
                      // A hand-opened child's first message: fold the parent's summary away.
                      const pc = m.text ? parseParentContext(m.text) : null;
                      if (!pc) {
                        const sent = m.text ? parseAttachedFiles(m.text) : null;
                        if (!sent) return null;
                        return <>{sent.text && <div>{sent.text}</div>}<SentFileChips files={sent.files} /></>;
                      }
                      return (
                        <>
                          <details className="msg-parent-ctx">
                            <summary>→ Context from parent: {pc.title}</summary>
                            <div className="msg-parent-ctx-body"><MarkdownText text={pc.summary} theme={theme} projectPath={projectPath} onOpenFile={openFile} /></div>
                          </details>
                          {pc.text && <div>{pc.text}</div>}
                        </>
                      );
                    })()}
                    <MessageActions
                      at={m.at}
                      onCopy={() => void copyMessage(m.text)}
                      onCopyLink={linkable(anchor) ? () => void copyMessageLink(anchor!) : undefined}
                      extra={anchor && canBookmark ? <BookmarkButton active={!!bookmarkedAnchors?.has(anchor)} onClick={() => bookmark(anchor, m.text)} /> : null}
                    />
                    {m.uuid && (
                      <button
                        type="button"
                        className="msg-user-edit-btn"
                        title="Revert to this point — discards later turns and rolls back any files claude changed since"
                        onClick={() => startEditUser(m)}
                        aria-label="Revert to this message"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="9 14 4 9 9 4" />
                          <path d="M4 9 h 11 a 5 5 0 0 1 0 10 h -4" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          }
          if (m.role === 'assistant') {
            return (
              <div key={m.id} className={`msg msg-assistant${bmCls}`} data-anchor={anchor ?? undefined}>
                <MarkdownText text={m.text} theme={theme} projectPath={projectPath} onOpenFile={openFile} />
                <MessageActions
                  at={m.at}
                  onCopy={() => void copyMessage(m.text)}
                  onCopyLink={linkable(anchor) ? () => void copyMessageLink(anchor!) : undefined}
                  onSideChat={onSideChatAbout ? () => sideChatAbout(m.text) : undefined}
                  extra={<>
                    {anchor && canBookmark && <BookmarkButton active={!!bookmarkedAnchors?.has(anchor)} onClick={() => bookmark(anchor, m.text)} />}
                    {showRichCopy && <RichCopyButton onClick={() => copyRich(m.text)} />}
                  </>}
                />
              </div>
            );
          }
          if (m.role === 'system') return <div key={m.id} className="msg msg-system">{m.text}</div>;
          if (m.role === 'bang') {
            return (
              <BangBlock
                key={m.id}
                msg={m}
                onInterrupt={m.bangId ? () => wsSend({ type: 'bang_interrupt', id: m.bangId }) : undefined}
              />
            );
          }
          if (m.role === 'thinking') return null;
          return renderToolBlock(m);
        })}
        {forms.renderOrphans()}
        {permAsks.map((a) => (
          <div key={a.id} className="msg msg-perm-ask">
            <div className="msg-perm-ask-head">
              {permissionHeadline(a.request)}
              {a.request.description && <span className="msg-perm-ask-desc"> — {a.request.description}</span>}
            </div>
            {a.request.detail && <pre className={`msg-perm-ask-detail ${a.request.detailKind}`}>{a.request.detail}</pre>}
            {(a.request.reason || a.request.blockedPath) && (
              <div className="msg-perm-ask-reason">{[a.request.reason, a.request.blockedPath ? `Path: ${a.request.blockedPath}` : ''].filter(Boolean).join(' · ')}</div>
            )}
            <div className="msg-plan-ask-actions">
              <button type="button" className="primary" onClick={() => answerPermission(a.id, true)}>Allow</button>
              {a.request.canRemember && <button type="button" onClick={() => answerPermission(a.id, true, true)} title="Allow this and the same kind of action for the rest of this session">Allow for this session</button>}
              <button type="button" onClick={() => answerPermission(a.id, false)}>Deny</button>
              <span className="msg-plan-ask-hint">or type below what to do instead</span>
            </div>
          </div>
        ))}
        {planAsk && (
          <div className="msg msg-plan-ask">
            <div className="msg-plan-ask-head">Claude's plan — nothing has been changed yet</div>
            <div className="msg-plan-ask-body msg-assistant"><MarkdownText text={planAsk.plan || '_(the plan is empty)_'} theme={theme} projectPath={projectPath} onOpenFile={openFile} /></div>
            <div className="msg-plan-ask-actions">
              <button type="button" className="primary" onClick={() => answerPlan(true)} title="Leave plan mode and carry the plan out">Approve and start</button>
              <button type="button" onClick={() => answerPlan(false)} title="Send the plan back; Claude stays in plan mode">Keep planning</button>
              <span className="msg-plan-ask-hint">or type below what to change</span>
            </div>
          </div>
        )}
        {activityLine ? (
          <div className="live-activity" role="status" aria-live="polite">
            <span className="live-activity-mark" aria-hidden="true"><i /><i /><i /></span>
            <span className="live-activity-text">{activityLine}</span>
          </div>
        ) : status === 'thinking' && (
          <div className="msg msg-thinking" aria-label="Claude is thinking">
            <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
          </div>
        )}
        {inBackground && (
          <div className="msg-awaiting bg" title={bgTasks.map((t) => `• ${t.description || (t.subagent ? 'subagent' : 'command')}`).join('\n')}>
            <span className="msg-awaiting-dot working" aria-hidden="true" />
            Working in the background — {bgTasks.length} task{bgTasks.length === 1 ? '' : 's'} still running{bgTasks[0]?.description ? `: ${bgTasks[0].description}${bgTasks.length > 1 ? ', …' : ''}` : ''}. Claude picks up again when {bgTasks.length === 1 ? 'it finishes' : 'they finish'}.
          </div>
        )}
        {!inBackground && status !== 'thinking' && status !== 'replaying' && awaitingUser(msgs) && (
          <div className="msg-awaiting"><span className="msg-awaiting-dot" aria-hidden="true" />Claude is awaiting instructions</div>
        )}
      </div>
      {(() => {
        const label = toast ?? (
          compacting && status === 'thinking' ? 'Compacting the conversation…'
            : status === 'ready' ? (bgTasks.length ? `Ready · ${bgTasks.length} background task${bgTasks.length === 1 ? '' : 's'} running` : 'Ready')
            : status === 'connecting' ? 'Connecting…'
            : status === 'reconnecting' ? 'Reconnecting…'
            : status === 'replaying' ? 'Loading history…'
            : status === 'closed' ? 'Disconnected'
            : status);
        const showLabel = status !== 'thinking' || !!toast || compacting;
        return (
          <div className={`chat-status status-${status}`}>
            <span>{showLabel ? label : ''}</span>
            <ClaudeUsageBadge />
            <ContextBadge
              context={contextUsage}
              compact={{
                run: (when) => send('/compact', when),
                working: status === 'thinking',
                blocked: compacting ? 'Compacting…'
                  : status !== 'ready' && status !== 'thinking' ? 'Not connected' : null,
              }}
            />
            {/* Always there: the model is only reported once the session has
                started (or run a turn), and switching must not wait for that. */}
            <div className="chat-status-model-wrap">
              <button
                className={`chat-status-mode mode-${mode}`}
                title={`${modeInfo(mode).label}: ${modeInfo(mode).description} — click to switch`}
                onClick={() => setModePickerOpen((v) => !v)}
                type="button"
              >{modeInfo(mode).short}</button>
              {modePickerOpen && (
                <>
                  <div className="model-picker-backdrop" onClick={() => setModePickerOpen(false)} />
                  <div className="model-picker mode-picker">
                    {MODES.map((mm) => (
                      <button key={mm.id} className={`mode-picker-item${mm.id === mode ? ' current' : ''}`} onClick={() => switchMode(mm.id)} type="button">
                        <span className="mode-picker-label">{mm.label}</span>
                        <span className="mode-picker-desc">{mm.description}</span>
                        {mm.id === mode && <span className="mode-picker-check" aria-hidden="true">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {(
              <div className="chat-status-model-wrap">
                <button
                  className={`chat-status-model${model ? '' : ' unknown'}`}
                  title={model
                    ? `${model}${effort ? ` · effort ${effort}` : ''} — click to switch`
                    : 'Claude\'s default model — its name shows once the session reports it. Click to choose a model.'}
                  onClick={() => setModelPickerOpen((v) => !v)}
                  type="button"
                >{model ?? 'default'}{effort ? ` · ${effort}` : ''}</button>
                <span className="chat-status-wire" title={"This tab drives Claude through the Agent SDK bridge. It is fixed for the tab; New / Resume use the bridge set in Settings → Claude → Claude bridge (this device)."}>sdk</span>
                {worktreeName && (
                  <span className="chat-status-wire chat-status-worktree" title={`This session works in its own git worktree: .claude/worktrees/${worktreeName} (branch child/${worktreeName}). Its file changes are not in the project's main checkout until merged.`}>⎇ {worktreeName}</span>
                )}
                {wireOn && (
                  <span className="chat-status-wire" title="Wire capture on: API requests/responses of this session are recorded under .aie/observations/wire/ (plaintext)">wire</span>
                )}
                {modelPickerOpen && (
                  <>
                    <div className="model-picker-backdrop" onClick={() => setModelPickerOpen(false)} />
                    <div className="model-picker">
                      {(() => {
                        const groups: { label: string; items: typeof modelCatalog.models }[] = [
                          { label: 'Aliases (auto-latest)', items: modelCatalog.aliases },
                          { label: 'Latest', items: modelCatalog.models.filter((mm) => mm.section === 'main') },
                          { label: 'Previous', items: modelCatalog.models.filter((mm) => mm.section !== 'main') },
                        ];
                        return groups.filter((g) => g.items.length > 0).map((g) => (
                          <div key={g.label} className="model-picker-group">
                            <div className="model-picker-group-label">{g.label}</div>
                            {g.items.map((mm) => (
                              <button key={mm.id} className={`model-picker-item ${mm.id === model ? 'current' : ''}`} onClick={() => switchModel(mm.id)} type="button" title={mm.description || ''}>
                                <span>{mm.name}</span>
                                <code className="model-picker-id">{mm.id}</code>
                              </button>
                            ))}
                          </div>
                        ));
                      })()}
                      {(() => {
                        const eo = effortOptionsFor(modelCatalog.models, model);
                        return (
                          <div className="model-picker-group">
                            <div className="model-picker-group-label">Effort</div>
                            {!eo.supported ? (
                              <div className="model-picker-group-label" style={{ padding: '4px 10px', opacity: 0.6 }}>Not supported by this model</div>
                            ) : (
                              <>
                                <button className={`model-picker-item ${effort === '' ? 'current' : ''}`} onClick={() => switchEffort('')} type="button" title="Let claude pick the per-model default">
                                  <span>Default</span>
                                  {eo.default && <code className="model-picker-id">{eo.default}</code>}
                                </button>
                                {eo.options.map((lvl) => (
                                  <button key={lvl} className={`model-picker-item ${effort === lvl ? 'current' : ''}`} onClick={() => switchEffort(lvl)} type="button"><span>{lvl}</span></button>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}
      {watches.length > 0 && (
        <div className="watch-bar" role="status">
          {watches.map((w) => (
            <div key={w.id} className="watch-bar-item" title={`Last seen: ${w.lastSeen}\nGives up at ${new Date(w.deadline).toLocaleString()}`}>
              <span className="watch-bar-icon" aria-hidden="true">⏳</span>
              <span className="watch-bar-text">Goes on by itself when <b>{w.label}</b> — or when you reply</span>
              <button type="button" className="watch-bar-cancel" aria-label={`Stop watching for ${w.label}`} title="Stop watching" onClick={() => wsSend({ type: 'watch_cancel', id: w.id })}>×</button>
            </div>
          ))}
        </div>
      )}
      {parentCtx.status !== 'off' && (
        <div className={`parent-ctx parent-ctx-${parentCtx.status}`}>
          <div className="parent-ctx-bar">
            {parentCtx.status === 'loading' && <><span className="parent-ctx-spin" aria-hidden="true" /><span>Summarizing parent session…</span></>}
            {parentCtx.status === 'ready' && (
              <>
                <span className="parent-ctx-mark" aria-hidden="true">→</span>
                <span>Includes context from parent:</span>
                <button type="button" className="parent-ctx-title" title="Show the summary that will be sent with your first message" aria-expanded={parentCtxOpen} onClick={() => setParentCtxOpen((v) => !v)}>{parentCtx.ctx.title}</button>
              </>
            )}
            {parentCtx.status === 'error' && <span title={parentCtx.message}>No parent summary ({parentCtx.message}) — your message is sent without it</span>}
            <button type="button" className="parent-ctx-close" title="Don't include the parent's context" aria-label="Don't include the parent's context" onClick={() => setParentCtx({ status: 'off' })}>×</button>
          </div>
          {parentCtx.status === 'ready' && parentCtxOpen && (
            <div className="parent-ctx-body"><MarkdownText text={parentCtx.ctx.summary} theme={theme} projectPath={projectPath} onOpenFile={openFile} /></div>
          )}
        </div>
      )}
      <QueuedMessages
        items={queued}
        working={status === 'thinking'}
        agent="Claude"
        onEdit={(id, text) => wsSend({ type: 'queue_edit', id, text })}
        onRemove={(id) => wsSend({ type: 'queue_remove', id })}
        onSendNow={(id) => wsSend({ type: 'queue_send_now', id })}
      />
      <ImageAttachmentStrip images={pendingImages} onRemove={attachments.remove} onOpen={setLightbox} />
      <FileAttachmentStrip files={fileAttachments.files} onRemove={fileAttachments.remove} />
      <ChatInput
        status={status}
        sendKey={sendKey}
        pendingImagesCount={pendingImages.length + fileAttachments.files.filter((f) => f.state === 'ready').length}
        anyFile
        uploading={fileAttachments.files.some((f) => f.state === 'uploading')}
        readyPlaceholder={sendKeyHint(sendKey)}
        thinkingPlaceholder="Claude is working — Send steers it now, ▾ for more"
        commands={commands}
        onCommandsOpen={refreshCommands}
        onSend={send}
        sendModes
        insertion={insertion}
        onBatchSent={onBatchSent}
        onAddFiles={addAnyFiles}
        onStop={stop}
        lock={forms.inputLock}
        bashMode
      />
      <CommentComposer containerRef={scrollRef} onAddToChat={addToChat} onComment={canComment ? submitComment : undefined} onSend={sendComment} highlightOwner={highlightOwner} onFocusComment={(id) => onFocusComment?.(id)} />
      {richCopySource}
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportDialog projectId={projectId} messages={toExport(msgs)} source="claude" theme={theme} onClose={() => setExportOpen(false)} />
        </Suspense>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
        </div>
      )}
      {toolPopout && toolPopout.role === 'tool' && (
        <div className="tool-popout-backdrop" onClick={() => setToolPopout(null)}>
          <div className="tool-popout-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tool-popout-header">
              <span className="tool-name">{toolPopout.name}</span>
              <span className="tool-summary">{summarizeTool(toolPopout.name, toolPopout.input, rel)}</span>
              <ToolCopyButton name={toolPopout.name} input={toolPopout.input} output={toolPopout.output} rel={rel} />
              <button className="tool-popout-close" onClick={() => setToolPopout(null)} aria-label="Close">×</button>
            </div>
            <div className="tool-popout-body">
              <ToolFields input={toolPopout.input} rel={rel} />
              {toolPopout.output !== undefined && (
                <div className="tool-field">
                  <div className="tool-field-key">output</div>
                  <pre className="tool-field-value tool-field-value-full">{rel(toolPopout.output)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
