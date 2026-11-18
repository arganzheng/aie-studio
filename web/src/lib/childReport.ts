// Model: Session.children — a child session's answer, as the server hands it
// to the parent's conversation (server/src/child-sessions.ts childReport).
// Parsed here so the chat can show it as a report card, not a typed prompt.

export type ChildReport = {
  title: string;
  sessionId: string;
  ok: boolean;
  // The user typed into the child during the turn; `body` then quotes what
  // they said ahead of the child's answer.
  intervened: boolean;
  body: string;
};

export function parseChildReport(text: string): ChildReport | null {
  const m = /^\[Child session "(.*?)" \(([A-Za-z0-9-]+)\) (finished after the user stepped in|finished|stopped with an error[^\]]*)\]\n\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const body = m[4]
    .replace(/\n\n\(Sent automatically by aie-studio[^)]*\)\s*$/, '')
    // A nudge for the parent agent, not for the reader.
    .replace(/\n\nIf this changes your plan, adjust it; otherwise no reply is needed\.\s*$/, '');
  return { title: m[1], sessionId: m[2], ok: m[3].startsWith('finished'), intervened: m[3] === 'finished after the user stepped in', body };
}
