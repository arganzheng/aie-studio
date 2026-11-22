// Model: Session.queue — messages the user chose to send after the running
// turn (by default a message written during a turn goes straight into it,
// read within seconds; see SendMode in web ChatInput). They wait on the server (so they still go out with the
// page closed, and every attached device sees the same list), can be edited
// or dropped, and go out together as one message when the turn ends. "Send
// now" takes one out and puts it into the running turn instead.

export type QueuedImage = { mediaType?: string; data?: string };
// interrupt: the user stopped the turn to send it; it goes out as soon as
// the turn has stopped.
export type QueuedPrompt = { id: string; text: string; images: QueuedImage[]; at: number; interrupt?: boolean };
// What a client is shown: no image data, just how many.
export type QueuedView = { id: string; text: string; images: number; at: number; interrupt?: boolean };

export const MAX_QUEUED = 20;
export const MAX_QUEUED_TEXT = 100_000;

export function queueView(items: readonly QueuedPrompt[]): QueuedView[] {
  return items.map((q) => ({ id: q.id, text: q.text, images: q.images.length, at: q.at, ...(q.interrupt ? { interrupt: true } : {}) }));
}

// Pure: the one message a queue goes out as — the texts in order, a blank
// line between them, every image after.
export function mergeQueued(items: readonly QueuedPrompt[]): { text: string; images: QueuedImage[] } {
  return {
    text: items.map((q) => q.text.trim()).filter(Boolean).join('\n\n'),
    images: items.flatMap((q) => q.images),
  };
}

// Pure: the queue with one item's text replaced. An item left with neither
// text nor images is dropped.
export function editQueued(items: readonly QueuedPrompt[], id: string, text: string): QueuedPrompt[] {
  const t = text.slice(0, MAX_QUEUED_TEXT);
  return items.flatMap((q) => (q.id !== id ? [q] : t.trim() || q.images.length ? [{ ...q, text: t }] : []));
}

// A slash command (`/compact`, `/plugin:cmd arg`), as opposed to text that
// starts with a path (`/tmp/x is wrong`). Same rule as web lib/steering.
export function isSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z][\w:-]*(\s|$)/.test(text);
}

export function isCompactCommand(text: string): boolean {
  return /^\s*\/compact(\s|$)/.test(text);
}

// Steering: a message written during a turn sends the command or subagent
// running in the foreground to the background, so the turn reads it at once
// instead of when that is done. Not for a slash command: the CLI runs those
// only once the turn has ended, so moving work aside would gain nothing.
export function steersRunningTurn(text: string): boolean {
  return !isSlashCommand(text);
}

// Stop and send `/compact` (or "Stop, compact, carry on" by the context
// card): what goes out after the compaction, so that Claude goes on with
// the work it was stopped in — `/compact` alone starts no turn.
export const CARRY_ON_AFTER_COMPACT = 'Carry on with what you were doing before I stopped you to compact the conversation.';

// Pure: the messages a queue goes out as, in order. A slash command goes on
// its own (merged into text it would be read as text, not run); runs of
// other items are merged as mergeQueued does.
export function batchQueued(items: readonly QueuedPrompt[]): Array<{ text: string; images: QueuedImage[]; at: number }> {
  const out: Array<{ text: string; images: QueuedImage[]; at: number }> = [];
  let run: QueuedPrompt[] = [];
  const close = () => {
    if (run.length) out.push({ ...mergeQueued(run), at: Math.min(...run.map((q) => q.at)) });
    run = [];
  };
  for (const q of items) {
    if (isSlashCommand(q.text) && q.images.length === 0) { close(); out.push({ text: q.text.trim(), images: [], at: q.at }); }
    else run.push(q);
  }
  close();
  return out.filter((b) => b.text || b.images.length);
}
