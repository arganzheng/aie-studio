// Model: server.ReadSdkTranscript — which records a page of the transcript
// starts at. The first page reaches back to the start of the turn in
// progress (the user's last message), so the chat shows that stretch of
// work whole: its time and step count are right from the start instead of
// growing as older pages come in.

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

// Pure: where a page ending at `end` starts. `limit` records at least; with
// `wholeTurn`, back to the last prompt before that if it is within `cap`.
export function pageStart(recs: readonly Rec[], end: number, limit: number, wholeTurn: boolean, cap = 500): number {
  const start = Math.max(0, end - limit);
  if (!wholeTurn) return start;
  const floor = Math.max(0, end - cap);
  for (let i = end - 1; i >= floor; i--) {
    if (isPrompt(recs[i])) return Math.min(start, i);
  }
  return start;
}
