import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { clampQuote, type CommentMark } from '../lib/review';
import { cleanSelection } from '../lib/addToChat';
import { marksAtPoint } from '../lib/quoteHighlight';

// What floats under a text selection. In a session panel: "Add to chat"
// (model: web.AddToChat — quote the passage into the prompt input, always
// available) and, when Review is on, "💬 Comment" (model:
// web.CommentOnSelection), which opens a small composer showing the quote +
// a textarea. Clicking an already painted quote lists the comments on it
// (model: web.ViewQuoteComments). The file viewer uses AddToChatSelection,
// the first button alone.

export type NewComment = { text: string; quote?: string; anchor?: string };
type Point = { x: number; y: number };
type Draft = { quote: string; anchor: string | null; at: Point };
const POPOVER_WIDTH = 320;
// Rough width of one floating button, to keep the row inside the viewport.
const ACTION_WIDTH = 112;

function below(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.bottom + 6 };
}

// The selected text. The code viewer's line-number gutter is part of the DOM
// selection (react-syntax-highlighter's .linenumber spans), so when the range
// touches any, read the text from a copy with them removed — inside <pre>
// that is exact. Elsewhere selection.toString() is right: it knows about
// block boundaries, which textContent does not.
function selectedText(s: Selection, range: Range): string {
  const copy = range.cloneContents();
  const gutter = copy.querySelectorAll('.linenumber');
  if (gutter.length === 0) return s.toString();
  gutter.forEach((n) => n.remove());
  return copy.textContent ?? '';
}

// The live text selection inside `containerRef`, or null. With an
// `itemSelector` the selection must start inside a matching element (a
// session's .msg), whose data-anchor is reported; without one, anywhere in
// the container counts. Frozen while `pausedRef` is set (composer open).
// Returns the selection and a way to drop it until the user selects again.
function useSelectedQuote(
  containerRef: RefObject<HTMLElement | null>,
  itemSelector: string | null,
  pausedRef?: RefObject<boolean>,
): [Draft | null, () => void] {
  const [sel, setSel] = useState<Draft | null>(null);
  useEffect(() => {
    function update() {
      if (pausedRef?.current) return;
      const root = containerRef.current;
      const s = document.getSelection();
      if (!root || !s || s.isCollapsed || s.rangeCount === 0) { setSel(null); return; }
      const range = s.getRangeAt(0);
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const item = itemSelector ? start?.closest<HTMLElement>(itemSelector) : start;
      const quote = cleanSelection(selectedText(s, range));
      if (!item || !root.contains(item) || !quote) { setSel(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { setSel(null); return; }
      setSel({ quote, anchor: (itemSelector && (item as HTMLElement).dataset.anchor) || null, at: below(rect) });
    }
    // Capture: scroll doesn't bubble, and the scroller may be the container
    // itself, a descendant (code viewer) or an ancestor.
    document.addEventListener('selectionchange', update);
    document.addEventListener('scroll', update, { capture: true, passive: true });
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('scroll', update, { capture: true });
    };
  }, [containerRef, itemSelector, pausedRef]);
  const clear = useCallback(() => setSel(null), []);
  return [sel, clear];
}

type SelectionAction = { label: string; title: string; onPick: () => void };

function SelectionActions({ at, actions }: { at: Point; actions: SelectionAction[] }) {
  const width = actions.length * ACTION_WIDTH;
  return (
    <div
      className="selection-actions"
      style={{ left: Math.max(8, Math.min(at.x - width / 2, window.innerWidth - width - 8)), top: Math.min(at.y, window.innerHeight - 40) }}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className="selection-action-btn"
          title={a.title}
          // pointerdown, not click: a touch tap collapses the selection (and
          // with it this button) before click would fire. preventDefault
          // keeps the selection painted while the composer is open.
          onPointerDown={(e) => { e.preventDefault(); a.onPick(); }}
        >{a.label}</button>
      ))}
    </div>
  );
}

const ADD_TO_CHAT_LABEL = '＋ Add to chat';

// Model: web.AddToChat outside a session (the file viewer): any selection
// inside the container floats the one button.
export function AddToChatSelection({ containerRef, onAddToChat }: {
  containerRef: RefObject<HTMLElement | null>;
  onAddToChat: (quote: string) => void;
}) {
  const [sel, clearSel] = useSelectedQuote(containerRef, null);
  if (!sel) return null;
  return (
    <SelectionActions
      at={sel.at}
      actions={[{
        label: ADD_TO_CHAT_LABEL,
        title: 'Quote this passage in the chat input',
        onPick: () => {
          onAddToChat(sel.quote);
          document.getSelection()?.removeAllRanges();
          clearSel();
        },
      }]}
    />
  );
}

export function CommentComposer({ containerRef, onAddToChat, onComment, onSend, highlightOwner, onFocusComment }: {
  // The scrolling message list; only selections inside one of its .msg count.
  containerRef: RefObject<HTMLElement | null>;
  // Model: web.AddToChat — quote the selection into the panel's prompt input.
  onAddToChat: (quote: string) => void;
  // Omitted when Review is off: no "💬 Comment" button, no composer.
  onComment?: (c: NewComment) => void;
  // Skip the Batch: append the comment to the panel's prompt input instead
  // (model: web.SendCommentToPrompt).
  onSend: (c: NewComment) => void;
  // The panel's applyQuoteHighlights owner, for hit-testing painted quotes.
  highlightOwner: object;
  // Show this comment in the Review panel.
  onFocusComment: (commentId: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<{ marks: CommentMark[]; at: Point } | null>(null);
  const draftOpenRef = useRef(false);
  draftOpenRef.current = !!draft;
  const [sel, clearSel] = useSelectedQuote(containerRef, '.msg', draftOpenRef);
  // A fresh selection replaces the list of comments on a clicked quote.
  useEffect(() => { if (sel) setViewing(null); }, [sel]);

  // Painted quotes are not elements: hit-test clicks / hovers against them.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const s = document.getSelection();
      if (draftOpenRef.current || (s && !s.isCollapsed)) return;
      const marks = marksAtPoint(highlightOwner, e.clientX, e.clientY);
      setViewing(marks.length ? { marks, at: { x: e.clientX, y: e.clientY + 12 } } : null);
    }
    let frame = 0;
    function onMove(e: MouseEvent) {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root!.style.cursor = marksAtPoint(highlightOwner, e.clientX, e.clientY).length ? 'pointer' : '';
      });
    }
    const dismiss = () => setViewing(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    root.addEventListener('click', onClick);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('scroll', dismiss, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.style.cursor = '';
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('scroll', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [containerRef, highlightOwner]);
  // Any press outside the list closes it (a click on another quote reopens).
  useEffect(() => {
    if (!viewing) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if ((e.target as Element | null)?.closest?.('.quote-comments')) return;
      setViewing(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [viewing]);

  function close() {
    setDraft(null);
    setText('');
  }

  function submit(deliver: (c: NewComment) => void) {
    if (!draft) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    deliver({ text: trimmed, quote: draft.quote || undefined, anchor: draft.anchor ?? undefined });
    close();
    document.getSelection()?.removeAllRanges();
  }

  if (draft) {
    const left = Math.max(8, Math.min(draft.at.x - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    // Not enough room below → sit above the anchor point instead.
    const flip = draft.at.y > window.innerHeight - 220;
    return (
      <div
        className="comment-popover"
        style={{ left, width: POPOVER_WIDTH, ...(flip ? { bottom: window.innerHeight - draft.at.y + 30 } : { top: draft.at.y }) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {draft.quote && <div className="comment-popover-quote">{draft.quote}</div>}
        <textarea
          autoFocus
          className="review-editor-input"
          placeholder="Comment… (⌘/Ctrl+Enter to save, +Shift to send)"
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(e.shiftKey ? onSend : onComment ?? onSend); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
        />
        <div className="review-editor-actions">
          <button type="button" className="review-editor-cancel" onClick={close}>Cancel</button>
          <button type="button" className="review-editor-send" title="Append to the prompt input, without adding it to a batch" onClick={() => submit(onSend)} disabled={!text.trim()}>Send</button>
          <button type="button" className="review-editor-save" title="Add to the current batch" onClick={() => submit(onComment ?? onSend)} disabled={!text.trim()}>Save</button>
        </div>
      </div>
    );
  }

  if (viewing && !sel) {
    const left = Math.max(8, Math.min(viewing.at.x - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    const flip = viewing.at.y > window.innerHeight - 160;
    return (
      <div
        className="comment-popover quote-comments"
        style={{ left, width: POPOVER_WIDTH, ...(flip ? { bottom: window.innerHeight - viewing.at.y + 30 } : { top: viewing.at.y }) }}
      >
        {viewing.marks.map((m) => (
          <button
            key={m.id}
            type="button"
            className="quote-comment"
            title="Show in the Review panel"
            onClick={() => { setViewing(null); onFocusComment(m.id); }}
          >
            <span className="quote-comment-text">{m.text}</span>
            <span className="quote-comment-batch">{m.batchName}{m.sent ? ' · sent' : ''}</span>
          </button>
        ))}
      </div>
    );
  }

  if (!sel) return null;
  const actions: SelectionAction[] = [{
    label: ADD_TO_CHAT_LABEL,
    title: 'Quote this passage in the chat input',
    onPick: () => {
      onAddToChat(sel.quote);
      document.getSelection()?.removeAllRanges();
      clearSel();
    },
  }];
  if (onComment) {
    actions.push({
      label: '💬 Comment',
      title: 'Comment on this passage',
      onPick: () => {
        setText('');
        // Comments are stored, so their quote is trimmed and capped; a quote
        // added to the chat is not.
        setDraft({ ...sel, quote: clampQuote(sel.quote.trim()) });
        clearSel();
      },
    });
  }
  return <SelectionActions at={sel.at} actions={actions} />;
}

// Flash a just-revealed message so the eye lands on it (model: web.RevealMessage).
export function flashMessage(el: HTMLElement) {
  el.classList.remove('msg-flash');
  void el.offsetWidth; // restart the animation if it was already running
  el.classList.add('msg-flash');
  window.setTimeout(() => el.classList.remove('msg-flash'), 1700);
}

export function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}
