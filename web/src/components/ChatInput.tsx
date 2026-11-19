import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SendKey } from '../types';
import { filterCommands, matchCommandQuery, type CommandItem } from '../lib/commandPicker';
import { imageFilesFromClipboard } from '../lib/imageAttachments';
import { isSendKeyTrigger } from '../lib/sendKey';
import { AttachImagesButton } from './ImageAttachments';
import { isBangInput } from '../lib/bang';
import { addQuotes, composeQuotedPrompt, quoteCardLabel, quoteCardPreview, type ChatQuote } from '../lib/addToChat';

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
  onSend: (text: string) => void;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Desktop-only height override (model: web.SendPrompt). Dragging the bar on
  // the input's top edge upward grows the textarea; persisted so tab switches
  // and reloads keep it. null = CSS default. Touch devices ignore the stored
  // value: their height is driven by content below.
  const [desktop] = useState(isDesktopPointer);
  const [height, setHeight] = useState<number | null>(() => (desktop ? loadInputHeight() : null));
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Touch devices (model: web.SendPrompt): no drag bar; the textarea follows
  // its content instead. Reset to auto first so shrinking works, then clamp.
  // Layout effect so the frame never paints at the stale height.
  useLayoutEffect(() => {
    if (desktop) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const max = Math.floor(viewport * MAX_AUTO_HEIGHT_VH);
    // scrollHeight excludes the border; box-sizing is border-box.
    const border = ta.offsetHeight - ta.clientHeight;
    ta.style.height = `${Math.min(max, Math.max(MIN_INPUT_HEIGHT, ta.scrollHeight + border))}px`;
  }, [text, desktop]);

  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>) {
    const ta = textareaRef.current;
    if (!ta) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: ta.offsetHeight };
  }
  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const max = Math.floor(window.innerHeight * MAX_INPUT_HEIGHT_VH);
    setHeight(Math.min(max, Math.max(MIN_INPUT_HEIGHT, d.startH + (d.startY - e.clientY))));
  }
  function onResizeUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const h = textareaRef.current?.offsetHeight;
    if (h) localStorage.setItem(INPUT_HEIGHT_KEY, String(h));
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
    const ta = textareaRef.current;
    // Trigger rule guarantees the "/query" token spans [0, cursor).
    const cursor = ta?.selectionStart ?? text.length;
    const next = item.insert + text.slice(cursor);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(item.insert.length, item.insert.length);
    });
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
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollTop = ta.scrollHeight;
    });
  }, [insertion]);

  function submit() {
    if (lock || uploading) return;
    if (!text.trim() && quotes.length === 0 && pendingImagesCount === 0) return;
    onSend(composeQuotedPrompt(quotes, text));
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
    <div className={`chat-input${lock ? ' locked' : ''}${bashMode && isBangInput(text) ? ' bash-mode' : ''}`}>
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
      <textarea
        ref={textareaRef}
        style={height != null ? { height } : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Input emptied by hand = the user dropped that send; the Batch stays draft.
          if (!e.target.value) pendingBatchIdsRef.current = [];
          syncQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={(e) => {
          if (lock) { lock.onShow?.(); return; }
          syncQuery(text, e.currentTarget.selectionStart ?? text.length);
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
          if (files.length) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            // While the picker is open, Enter/Tab pick regardless of sendKey.
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[selIdx]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if (isSendKeyTrigger(sendKey, e)) { e.preventDefault(); submit(); }
        }}
      />
      {lock && (
        <button
          className="chat-unlock"
          onClick={lock.onUnlock}
          title="Type in chat anyway — the form above stays open until you answer it"
        >Unlock</button>
      )}
      <button onClick={submit} disabled={!canSend} title={uploading ? 'Waiting for the attached files to upload' : undefined}>{uploading ? 'Uploading…' : 'Send'}</button>
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
