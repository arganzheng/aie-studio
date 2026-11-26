import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Annotation, Compartment, EditorState, Facet, Prec, RangeSetBuilder, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder as placeholderExt, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { findMentions, type MentionInfo, type MentionResolver } from '../lib/mentions';

// The prompt box's editor (model: web.SendPrompt): a CodeMirror view that
// behaves like the textarea it replaced. Its document is the prompt as plain
// text, nothing else: everything ChatInput derives from the prompt ("/"
// picker, "!" bash mode, quotes, queued sends) keeps working on a string.
// CodeMirror is here so that parts of that text can later be drawn as
// widgets (file and session mentions) without the prompt becoming a tree.

export type PromptEditorHandle = {
  focus: () => void;
  // Put the cursor at `pos` ('end' = after the last character, scrolled into
  // view) and focus the editor.
  focusAt: (pos: number | 'end') => void;
  cursor: () => number;
  // The editor's outer element, for measuring its height.
  element: () => HTMLElement | null;
};

type Props = {
  value: string;
  // The user edited the text; `cursor` is where the caret ended up.
  onChange: (value: string, cursor: number) => void;
  // A key went down in the editor. Return true to say it was handled:
  // the editor then does nothing with it.
  onKeyDown?: (e: KeyboardEvent) => boolean;
  // Return true when the paste was taken (files): no text is inserted then.
  onPaste?: (e: ClipboardEvent) => boolean;
  onClick?: (cursor: number) => void;
  onBlur?: () => void;
  placeholder: string;
  // Model: web.FileMentions. Says which "@token"s in the text are mentions
  // and what each is drawn as; those are shown as chips. Omit for none.
  resolveMention?: MentionResolver | null;
  // Text can be read and selected but not changed.
  readOnly?: boolean;
  // Not usable at all (session closed).
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

// ----- mentions drawn as chips (model: web.FileMentions) -------------------
// The text stays "@src/a.ts"; the chip is only how that range is drawn. It is
// atomic: the cursor steps over it and Backspace removes it whole.
const mentionResolver = Facet.define<MentionResolver | null, MentionResolver | null>({
  combine: (values) => values.find((v) => v != null) ?? null,
});

class MentionWidget extends WidgetType {
  constructor(readonly info: MentionInfo) { super(); }
  eq(other: MentionWidget) {
    return other.info.kind === this.info.kind && other.info.label === this.info.label && other.info.title === this.info.title;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = `mention-chip mention-${this.info.kind}`;
    el.title = this.info.title;
    const icon = document.createElement('span');
    icon.className = 'mention-icon';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = this.info.label;
    el.append(icon, label);
    return el;
  }
  ignoreEvent() { return false; }
}

function mentionDecorations(state: EditorState): DecorationSet {
  const resolve = state.facet(mentionResolver);
  if (!resolve) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  for (const r of findMentions(state.doc.toString(), resolve)) {
    b.add(r.from, r.to, Decoration.replace({ widget: new MentionWidget(r.info) }));
  }
  return b.finish();
}

const mentionField = StateField.define<DecorationSet>({
  create: mentionDecorations,
  update(value, tr) {
    return tr.docChanged || tr.startState.facet(mentionResolver) !== tr.state.facet(mentionResolver) ? mentionDecorations(tr.state) : value;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
});

// Marks a change the component made itself to follow `value`, so it is not
// reported back through onChange.
const fromProp = Annotation.define<boolean>();

// Like a textarea in a chat box: the phone keyboard corrects and capitalises,
// the browser spell-checks. (CodeMirror's defaults are those of a code editor.)
const contentAttrs = EditorView.contentAttributes.of({
  'aria-label': 'Prompt',
  spellcheck: 'true',
  autocorrect: 'on',
  autocapitalize: 'sentences',
});

function editableExt(readOnly: boolean, disabled: boolean): Extension {
  return [EditorState.readOnly.of(readOnly || disabled), EditorView.editable.of(!disabled)];
}

export const PromptEditor = forwardRef<PromptEditorHandle, Props>(function PromptEditor(
  { value, onChange, onKeyDown, onPaste, onClick, onBlur, placeholder, resolveMention = null, readOnly = false, disabled = false, className, style },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The view is made once; its handlers read the latest props from here.
  const cb = useRef({ onChange, onKeyDown, onPaste, onClick, onBlur });
  cb.current = { onChange, onKeyDown, onPaste, onClick, onBlur };
  const compartments = useRef({ placeholder: new Compartment(), editable: new Compartment(), mentions: new Compartment() });

  useEffect(() => {
    const c = compartments.current;
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Before every keymap: the send key, and the "/" picker's keys.
          Prec.highest(EditorView.domEventHandlers({
            keydown: (e, v) => {
              // A key that belongs to the input method (choosing a candidate,
              // confirming with Enter) is never a command. 229 covers Safari,
              // which reports the confirming Enter as not composing.
              if (e.isComposing || v.composing || e.keyCode === 229) return false;
              if (cb.current.onKeyDown?.(e)) { e.preventDefault(); return true; }
              return false;
            },
            paste: (e) => {
              if (cb.current.onPaste?.(e)) { e.preventDefault(); return true; }
              return false;
            },
          })),
          EditorView.domEventHandlers({
            click: (_e, v) => { cb.current.onClick?.(v.state.selection.main.head); },
            blur: () => { cb.current.onBlur?.(); },
          }),
          history(),
          keymap.of([
            // A textarea's Enter: a plain line break, no indentation, with or
            // without Shift. Mod-Enter does nothing unless it is the send key.
            { key: 'Enter', run: insertNewline, shift: insertNewline },
            { key: 'Mod-Enter', run: () => true },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          contentAttrs,
          c.placeholder.of(placeholderExt(placeholder)),
          c.editable.of(editableExt(readOnly, disabled)),
          c.mentions.of(mentionResolver.of(resolveMention)),
          mentionField,
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            if (u.transactions.some((t) => t.annotation(fromProp))) return;
            cb.current.onChange(u.state.doc.toString(), u.state.selection.main.head);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // Made once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow `value` when it was changed from outside (sent, a command picked,
  // a prompt inserted). The user's own edits already match.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === value) return;
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: value },
      selection: { anchor: value.length },
      annotations: fromProp.of(true),
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.placeholder.reconfigure(placeholderExt(placeholder)) });
  }, [placeholder]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.editable.reconfigure(editableExt(readOnly, disabled)) });
  }, [readOnly, disabled]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.mentions.reconfigure(mentionResolver.of(resolveMention)) });
  }, [resolveMention]);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    focusAt: (pos) => {
      const view = viewRef.current;
      if (!view) return;
      const len = view.state.doc.length;
      const at = pos === 'end' ? len : Math.max(0, Math.min(len, pos));
      view.focus();
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    },
    cursor: () => viewRef.current?.state.selection.main.head ?? 0,
    element: () => hostRef.current,
  }), []);

  return (
    <div
      ref={hostRef}
      className={`prompt-editor${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    />
  );
});
