// Model: Session.queue — messages the user chose to send after the running
// turn (by default a message written during a turn goes straight into it,
// read at its next step; see SendMode in web ChatInput). They wait on the server (so they still go out with the
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
