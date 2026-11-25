// Model: server.ReadSdkTranscript — which records a page of the transcript
// starts at. Every page starts where a turn starts (a message the user
// wrote), so the chat never holds part of a stretch of work: its time and
// step count are right as soon as it shows, instead of growing as older
// pages come in.

type Rec = { type?: unknown; message?: unknown };

const NOTICE = /^\s*<task-notification>/;

// A message the user wrote (or a report put in their place): not a tool
// result, not a background task's notification (that is part of the work).
export function isPrompt(r: Rec): boolean {
  if (r.type !== 'user') return false;
  const c = (r.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c.trim() !== '' && !NOTICE.test(c);
  if (!Array.isArray(c)) return false;
  return c.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && !NOTICE.test(String((b as { text?: unknown }).text ?? '')))
    && !c.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');
}

// Pure: where a page ending at `end` starts. `limit` records at least, then
// back to the prompt that opens the turn the cut falls in, so no page starts
// in the middle of a turn. A turn longer than `cap` records is cut anyway.
export function pageStart(recs: readonly Rec[], end: number, limit: number, cap = 500): number {
  const start = Math.max(0, end - limit);
  const floor = Math.max(0, end - cap);
  for (let i = start; i >= floor; i--) {
    if (i === 0 || isPrompt(recs[i])) return i;
  }
  return start;
}
