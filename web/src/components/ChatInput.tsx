import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SendKey } from '../types';
import { filterCommands, matchCommandQuery, type CommandItem } from '../lib/commandPicker';
import { imageFilesFromClipboard } from '../lib/imageAttachments';
import { isSendKeyTrigger } from '../lib/sendKey';
import { AttachImagesButton } from './ImageAttachments';
import { PromptEditor, type PromptEditorHandle } from './PromptEditor';
import { isBangInput } from '../lib/bang';
import { isCompactCommand, isSlashCommand } from '../lib/steering';
import { addQuotes, composeQuotedPrompt, quoteCardLabel, quoteCardPreview, type ChatQuote } from '../lib/addToChat';
import { dragHasFiles, droppedFiles } from '../lib/fileAttachments';

export type ChatInputStatus =
  | 'connecting'
  | 'replaying'
  | 'ready'
  | 'thinking'
  | 'reconnecting'
  | 'closed';

const INPUT_HEIGHT_KEY = 'chatInputHeight';
const MIN_INPUT_HEIGHT = 40;
const MAX_INPUT_HEIGHT_VH = 0.5;
// Touch devices: the input grows with its content up to this share of the
// *visual* viewport, which shrinks when the on-screen keyboard is up.
const MAX_AUTO_HEIGHT_VH = 0.4;

// Same query as .chat-input-resize in styles.css: mouse devices get the drag
// bar, everything else auto-grows. A function, not a module constant: the
// module is imported (via builtinTabKinds) in node-side tests with no window.
function isDesktopPointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

// Model: web.InsertBatchPrompt — a composed Review Batch to put in the input
// box. `seq` makes re-inserting the same batch a new event. No batchId = a
// single comment sent directly (model: web.SendCommentToPrompt). `quotes`
// become cards above the input instead of text (model: web.AddToChat).
export type PromptInsertion = { seq: number; text: string; batchId?: string; quotes?: ChatQuote[] };

// Model: web.PendingFormInputLock rule-309. While set, the textarea is
// read-only (text is kept, not cleared), Send / attach are disabled, the
// placeholder explains why, and an Unlock button lifts the lock. Clicking the
// read-only textarea calls onShow so the panel can scroll to the form.
export type InputLock = { reason: string; onUnlock: () => void; onShow?: () => void };

function loadInputHeight(): number | null {
  const n = Number(localStorage.getItem(INPUT_HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_INPUT_HEIGHT ? n : null;
}

// Model: Session.queue — how a message written during a turn goes out:
// into the running turn at once (the default: a command or subagent running
// in the foreground goes on in the background, so the turn reads it within
// seconds), after stopping the turn, or once the turn has ended (queued,
// editable until then).
export type SendMode = 'now' | 'interrupt' | 'queue';
const SEND_MODES: ReadonlyArray<{ mode: SendMode; label: string; hint: string }> = [
  { mode: 'now', label: 'Send now', hint: 'Claude reads it within seconds; a running command keeps going in the background (default)' },
  { mode: 'interrupt', label: 'Stop and send', hint: 'Stop everything it is doing, running commands included, and answer this' },
  { mode: 'queue', label: 'Send after this turn', hint: 'Wait above the input, editable, until the turn ends' },
];

export const ChatInput = memo(function ChatInput({
  status,
  sendKey,
  pendingImagesCount,
  readyPlaceholder,
  thinkingPlaceholder,
  commands,
  onCommandsOpen,
  insertion,
  onBatchSent,
  onSend,
  onAddFiles,
  anyFile = false,
  uploading = false,
  onStop,
  lock,
  bashMode = false,
  sendModes = false,
}: {
  status: ChatInputStatus;
  sendKey: SendKey;
  pendingImagesCount: number;
  readyPlaceholder: string;
  thinkingPlaceholder: string;
  // "/" command picker (model: web.CommandPicker). Omit to disable. Claude
  // passes the .claude/ scan (skills + agents); Devin passes the commands the
  // agent advertised over ACP.
  commands?: CommandItem[];
  // Fired when the picker opens; caller can refetch the catalog in the background.
  onCommandsOpen?: () => void;
  // Model: web.InsertBatchPrompt. The text is appended (never sent) so the
  // user can review it; onBatchSent fires for each inserted Batch once the
  // prompt actually goes out.
  insertion?: PromptInsertion | null;
  onBatchSent?: (batchId: string) => void;
  onSend: (text: string, mode?: SendMode) => void;
  // While the agent works, a ▾ next to Send offers the other SendModes.
  sendModes?: boolean;
  onAddFiles: (files: FileList | File[]) => void;
  // Model: web.FileAttachments. anyFile: the attach button and paste take
  // every kind of file, not only images. uploading: an attachment is still
  // on its way, so the prompt can't go yet. pendingImagesCount then counts
  // images and files alike.
  anyFile?: boolean;
  uploading?: boolean;
  onStop: () => void;
  // Model: web.PendingFormInputLock. null/undefined = editable as usual.
  lock?: InputLock | null;
  // Model: web.BangCommand. Panels that run `!command` locally set this so a
  // leading "!" is shown as bash mode (Claude Code CLI style).
  bashMode?: boolean;
}) {
  const [text, setText] = useState('');
  // Model: web.AddToChat — quote cards waiting above the input.
  const [quotes, setQuotes] = useState<ChatQuote[]>([]);
  // The card whose full text is shown (tap / click a card): the card itself
  // only fits one line, and touch has no hover to reveal the rest.
  const [openQuote, setOpenQuote] = useState<ChatQuote | null>(null);
  const quoteAreaRef = useRef<HTMLDivElement>(null);
  const shownQuote = openQuote && quotes.includes(openQuote) ? openQuote : null;
  useEffect(() => {
    if (!shownQuote) return;
    const onDown = (e: Event) => {
      if (!quoteAreaRef.current?.contains(e.target as Node)) setOpenQuote(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenQuote(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shownQuote]);
  // null = picker closed; string = query after the leading "/".
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const editorRef = useRef<PromptEditorHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Desktop-only height override (model: web.SendPrompt). Dragging the bar on
  // the input's top edge upward grows the textarea; persisted so tab switches
  // and reloads keep it. null = CSS default. Touch devices ignore the stored
  // value: their height is driven by content below.
  const [desktop] = useState(isDesktopPointer);
  const [height, setHeight] = useState<number | null>(() => (desktop ? loadInputHeight() : null));
  // `h`: the height the drag has reached, once it has moved.
  const dragRef = useRef<{ startY: number; startH: number; h?: number } | null>(null);

  // Touch devices (model: web.SendPrompt): no drag bar; the editor follows
  // its content instead (it grows by itself), up to a share of the visual
  // viewport, which is re-read on every edit: the on-screen keyboard changes it.
  // Layout effect so the frame never paints past the cap.
  useLayoutEffect(() => {
    if (desktop) return;
    const el = editorRef.current?.element();
    if (!el) return;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    el.style.maxHeight = `${Math.max(MIN_INPUT_HEIGHT, Math.floor(viewport * MAX_AUTO_HEIGHT_VH))}px`;
  }, [text, desktop]);

  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = editorRef.current?.element();
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: el.offsetHeight };
  }
  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const max = Math.floor(window.innerHeight * MAX_INPUT_HEIGHT_VH);
    d.h = Math.min(max, Math.max(MIN_INPUT_HEIGHT, d.startH + (d.startY - e.clientY)));
    setHeight(d.h);
  }
  function onResizeUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // The height the drag reached, not the element's: the last move may not
    // have been drawn yet, and the element would then give the one before it.
    if (d.h != null) localStorage.setItem(INPUT_HEIGHT_KEY, String(d.h));
  }
  function onResizeReset() {
    setHeight(null);
    localStorage.removeItem(INPUT_HEIGHT_KEY);
  }

  const matches = commands && query != null ? filterCommands(commands, query) : [];
  const open = matches.length > 0;
  const selIdx = Math.min(sel, Math.max(0, matches.length - 1));

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) onCommandsOpen?.();
    wasOpenRef.current = open;
  }, [open, onCommandsOpen]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, selIdx]);

  function syncQuery(value: string, cursor: number) {
    if (!commands) return;
    setQuery(matchCommandQuery(value.slice(0, cursor)));
    setSel(0);
  }

  function pick(item: CommandItem) {
    // Trigger rule guarantees the "/query" token spans [0, cursor).
    const cursor = editorRef.current?.cursor() ?? text.length;
    const next = item.insert + text.slice(cursor);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => editorRef.current?.focusAt(item.insert.length));
  }

  // Batches whose prompt currently sits in the input, unsent.
  const pendingBatchIdsRef = useRef<string[]>([]);
  const lastInsertionSeqRef = useRef(0);
  useEffect(() => {
    if (!insertion || insertion.seq === lastInsertionSeqRef.current) return;
    lastInsertionSeqRef.current = insertion.seq;
    if (insertion.batchId && !pendingBatchIdsRef.current.includes(insertion.batchId)) pendingBatchIdsRef.current.push(insertion.batchId);
    if (insertion.quotes?.length) setQuotes((prev) => addQuotes(prev, insertion.quotes!));
    if (insertion.text) setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${insertion.text}` : insertion.text));
    setQuery(null);
    requestAnimationFrame(() => editorRef.current?.focusAt('end'));
  }, [insertion]);

  const [modeMenu, setModeMenu] = useState(false);
  useEffect(() => { if (status !== 'thinking') setModeMenu(false); }, [status]);
  useEffect(() => {
    if (!modeMenu) return;
    const onDown = (e: Event) => { if (!(e.target as HTMLElement).closest?.('.send-modes')) setModeMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [modeMenu]);
  function submit(mode?: SendMode) {
    setModeMenu(false);
    if (lock || uploading) return;
    if (!text.trim() && quotes.length === 0 && pendingImagesCount === 0) return;
    onSend(composeQuotedPrompt(quotes, text), mode);
    // The panel drops sends while it has no live connection (!canSend); keep
    // the cards then, the user would have no way to get them back.
    if (canSend) {
      for (const id of pendingBatchIdsRef.current) onBatchSent?.(id);
      setQuotes([]);
    }
    pendingBatchIdsRef.current = [];
    setText('');
    setQuery(null);
  }

  // Model: web.FileAttachments — files dragged onto the input are attached
  // like ones picked with the button.
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const canDrop = status !== 'closed' && !lock;

  // A slash command written during a turn waits for the turn to end (the
  // CLI runs it then), unlike text, which the turn reads at once.
  const slashWaits = sendModes && status === 'thinking' && isSlashCommand(text);

  const canSend =
    !lock &&
    !uploading &&
    status !== 'closed' &&
    status !== 'connecting' &&
    status !== 'reconnecting' &&
    status !== 'replaying' &&
    (text.trim().length > 0 || quotes.length > 0 || pendingImagesCount > 0);

  return (
    <>
    {quotes.length > 0 && (
      <div className="chat-quote-area" ref={quoteAreaRef}>
        {shownQuote && (
          <div className="quote-card-full" role="dialog" aria-label="Quoted passage">
            <div className="quote-card-full-head">
              <span>{quoteCardLabel(shownQuote)}</span>
              <button type="button" onClick={() => setOpenQuote(null)} title="Close" aria-label="Close">×</button>
            </div>
            <div className="quote-card-full-text">{shownQuote.quote}</div>
            {shownQuote.comment && <div className="quote-card-full-comment">{shownQuote.comment}</div>}
          </div>
        )}
        <div className="chat-quote-cards">
          {quotes.map((q, i) => (
            <div
              key={`${i}:${quoteCardLabel(q)}:${q.quote.length}`}
              className={`quote-card${q === shownQuote ? ' open' : ''}`}
              role="button"
              tabIndex={0}
              title="Show the full quote"
              onClick={() => setOpenQuote((cur) => (cur === q ? null : q))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenQuote((cur) => (cur === q ? null : q)); }
              }}
            >
              {q.comment ? (
                <>
                  <div className="quote-card-label">💬 “{quoteCardPreview(q)}”</div>
                  <div className="quote-card-text">{q.comment.replace(/\s+/g, ' ')}</div>
                </>
              ) : (
                <>
                  <div className="quote-card-label">{quoteCardLabel(q)}</div>
                  <div className="quote-card-text">“{quoteCardPreview(q)}”</div>
                </>
              )}
              <button
                type="button"
                className="quote-card-del"
                onClick={(e) => { e.stopPropagation(); setQuotes((prev) => prev.filter((_, j) => j !== i)); }}
                title="Remove quote"
                aria-label="Remove quote"
              >×</button>
            </div>
          ))}
        </div>
      </div>
    )}
    <div
      className={`chat-input${lock ? ' locked' : ''}${bashMode && isBangInput(text) ? ' bash-mode' : ''}${dragOver ? ' drag-over' : ''}`}
      onDragEnter={(e) => { if (!canDrop || !dragHasFiles(e.dataTransfer?.types)) return; e.preventDefault(); dragDepth.current++; setDragOver(true); }}
      onDragOver={(e) => { if (!canDrop || !dragHasFiles(e.dataTransfer?.types)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={() => { if (dragDepth.current > 0 && --dragDepth.current === 0) setDragOver(false); }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDragOver(false);
        if (!canDrop || !dragHasFiles(e.dataTransfer?.types)) return;
        e.preventDefault();
        const files = droppedFiles(e.dataTransfer.items, anyFile);
        if (files.length) onAddFiles(files);
      }}
    >
      {dragOver && <div className="chat-input-drop" aria-hidden="true">{anyFile ? 'Drop files to attach' : 'Drop images to attach'}</div>}
      {slashWaits && (isCompactCommand(text)
        ? <span className="chat-input-slash-note" title="Send queues it: it compacts once this turn has ended. ▾ Stop and send stops Claude now, compacts, and has it carry on.">Send: compact after this turn · ▾ Stop and send: compact now, then carry on</span>
        : <span className="chat-input-slash-note" title="Slash commands run once this turn has ended: Send queues it. ▾ Stop and send runs it now.">Send: queued, runs after this turn · ▾ Stop and send to run now</span>)}
      {bashMode && isBangInput(text) && <span className="chat-input-bash-badge" title="Runs in the project directory; output goes to Claude with your next message">! bash</span>}
      <div
        className="chat-input-resize"
        title="Drag up to enlarge; double-click to reset"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={onResizeReset}
      />
      {open && (
        <div className="cmd-popover" ref={listRef} role="listbox">
          {matches.map((item, idx) => {
            const groupStart = idx === 0 || matches[idx - 1].group !== item.group;
            return (
              <div key={`${item.group}:${item.name}`}>
                {groupStart && <div className="cmd-group">{item.group}</div>}
                <div
                  className={`cmd-item${idx === selIdx ? ' active' : ''}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === selIdx}
                  // preventDefault keeps focus (and the mobile keyboard) on the textarea.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                  onMouseEnter={() => setSel(idx)}
                >
                  <div className="cmd-item-name">{item.label}</div>
                  {item.description && <div className="cmd-item-desc">{item.description}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AttachImagesButton onFiles={onAddFiles} anyFile={anyFile} disabled={status === 'closed' || !!lock} />
      <PromptEditor
        ref={editorRef}
        style={height != null ? { height } : undefined}
        value={text}
        onChange={(value, cursor) => {
          setText(value);
          // Input emptied by hand = the user dropped that send; the Batch stays draft.
          if (!value) pendingBatchIdsRef.current = [];
          syncQuery(value, cursor);
        }}
        onClick={(cursor) => {
          if (lock) { lock.onShow?.(); return; }
          syncQuery(text, cursor);
        }}
        onBlur={() => setQuery(null)}
        readOnly={!!lock}
        placeholder={
          lock ? lock.reason
          : status === 'closed' ? 'closed'
          : status === 'thinking' ? thinkingPlaceholder
          : status === 'connecting' || status === 'reconnecting' || status === 'replaying' ? status
          : readyPlaceholder
        }
        disabled={status === 'closed'}
        onPaste={(e) => {
          const files = anyFile ? Array.from(e.clipboardData?.files ?? []) : imageFilesFromClipboard(e.clipboardData?.items);
          if (!files.length) return false;
          onAddFiles(files);
          return true;
        }}
        onKeyDown={(e) => {
          if (open) {
            // While the picker is open, Enter/Tab pick regardless of sendKey.
            if (e.key === 'ArrowDown') { setSel((s) => (s + 1) % matches.length); return true; }
            if (e.key === 'ArrowUp') { setSel((s) => (s - 1 + matches.length) % matches.length); return true; }
            if (e.key === 'Enter' || e.key === 'Tab') { pick(matches[selIdx]); return true; }
            if (e.key === 'Escape') { setQuery(null); return true; }
          }
          if (isSendKeyTrigger(sendKey, e)) { submit(); return true; }
          return false;
        }}
      />
      {lock && (
        <button
          className="chat-unlock"
          onClick={lock.onUnlock}
          title="Type in chat anyway — the form above stays open until you answer it"
        >Unlock</button>
      )}
      <button onClick={() => submit()} disabled={!canSend} title={uploading ? 'Waiting for the attached files to upload' : sendModes && status === 'thinking' ? (slashWaits ? 'Queued: slash commands run once this turn has ended' : 'Claude reads it within seconds; a running command keeps going in the background') : undefined}>{uploading ? 'Uploading…' : 'Send'}</button>
      {sendModes && status === 'thinking' && (
        <div className="send-modes">
          <button
            type="button"
            className="send-modes-btn"
            title="More ways to send while it works"
            aria-label="More ways to send"
            aria-expanded={modeMenu}
            disabled={!canSend}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setModeMenu((v) => !v)}
          >▾</button>
          {modeMenu && (
            <div className="send-modes-menu" role="menu">
              {SEND_MODES.map((m) => (
                <button key={m.mode} type="button" role="menuitem" className="overflow-action" onMouseDown={(e) => e.preventDefault()} onClick={() => submit(m.mode)}>
                  <span className="send-modes-label">{m.label}</span>
                  <span className="send-modes-hint">{m.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {status === 'thinking' && (
        <button
          className="chat-stop"
          onClick={onStop}
          title="Interrupt current turn"
        >Stop</button>
      )}
    </div>
    </>
  );
});
