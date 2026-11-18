// Model: web.NewChildSession "Includes context from parent" — a summary of
// the parent session, attached ahead of the first message of a child the
// user opened by hand. Kept in the message text itself (the child's agent
// must read it), in a frame the chat can fold away.

const OPEN = (title: string) => `[Context from parent session "${title}"]`;
const CLOSE = '[End of context from parent session]';

export type ParentContext = { title: string; summary: string };

export function withParentContext(ctx: ParentContext, text: string): string {
  // The title sits inside quotes on one line: keep it there.
  const title = ctx.title.replace(/["\n\r]/g, ' ').trim() || 'parent';
  return `${OPEN(title)}\n${ctx.summary.trim()}\n${CLOSE}\n\n${text}`;
}

// The frame and what the user typed after it; null for an ordinary message.
export function parseParentContext(message: string): (ParentContext & { text: string }) | null {
  const m = /^\[Context from parent session "([^"\n]*)"\]\n([\s\S]*?)\n\[End of context from parent session\]\n?\n?([\s\S]*)$/.exec(message);
  if (!m) return null;
  return { title: m[1], summary: m[2], text: m[3] };
}
