import { useState } from 'react';

// Model: Session.queue (web side) — the messages written while the agent was
// in the middle of a turn, shown above the input. They wait on the server
// and go out together, as one message, when the turn ends. Each can be
// edited, dropped, or sent now (into the running turn, at its next step).

export type QueuedView = { id: string; text: string; images: number; at: number };

export function parseQueue(v: unknown): QueuedView[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (x && typeof x.id === 'string'
    ? [{ id: x.id, text: typeof x.text === 'string' ? x.text : '', images: Number(x.images) || 0, at: Number(x.at) || 0 }]
    : []));
}

export function QueuedMessages({ items, working, agent, onEdit, onRemove, onSendNow }: {
  items: readonly QueuedView[];
  // The agent is in the middle of a turn (else the queue is left over from a
  // stopped one and waits for the user).
  working: boolean;
  agent: string;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  if (items.length === 0) return null;
  const save = () => {
    if (!editing) return;
    const cur = items.find((q) => q.id === editing.id);
    if (cur && cur.text !== editing.text) onEdit(editing.id, editing.text);
    setEditing(null);
  };
  return (
    <div className="queued" aria-label="Queued messages">
      <div className="queued-head">
        {working
          ? `Queued · sent as one message when ${agent} finishes this turn`
          : `Queued · ${agent} stopped before these went out`}
      </div>
      {items.map((q) => (
        <div key={q.id} className="queued-item">
          {editing?.id === q.id ? (
            <textarea
              autoFocus
              className="queued-edit"
              value={editing.text}
              rows={Math.min(6, Math.max(2, editing.text.split('\n').length))}
              onChange={(e) => setEditing({ id: q.id, text: e.target.value })}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
              }}
            />
          ) : (
            <div className="queued-text" title="Click to edit" onClick={() => setEditing({ id: q.id, text: q.text })}>
              {q.text || <em>(no text)</em>}
              {q.images > 0 && <span className="queued-images"> · {q.images} image{q.images === 1 ? '' : 's'}</span>}
            </div>
          )}
          <div className="queued-actions">
            <button type="button" title="Edit" aria-label="Edit" onMouseDown={(e) => e.preventDefault()} onClick={() => (editing?.id === q.id ? save() : setEditing({ id: q.id, text: q.text }))}>✎</button>
            <button
              type="button"
              className="queued-now"
              title={working ? `Send it into the running turn now — ${agent} reads it at its next step` : 'Send it now'}
              onClick={() => { if (editing?.id === q.id) save(); onSendNow(q.id); }}
            >{working ? 'Send now' : 'Send'}</button>
            <button type="button" title="Remove from the queue" aria-label="Remove from the queue" onClick={() => onRemove(q.id)}>×</button>
          </div>
        </div>
      ))}
    </div>
  );
}
