// Model: Session.status — the phrase an agent leaves as the last line of its
// reply when its turn ends, saying what the session is waiting for
// (server/src/session-status.ts writes the rule and stores the phrase). The
// chat panels hide the line and, for "needs-you", say so under the reply.

export type StatusTone = 'needs-you' | 'ready';
export type SessionStatus = { tone: StatusTone; label: string };

const MARKER_RE = /<!--\s*status\s+(needs-you|ready)\s*:\s*([^\n]*?)\s*-->/gi;
const OPEN_TAIL_RE = /<!--(?:(?!-->)[\s\S])*$/;
const OPEN_MARKER_RE = /^<!--\s*(s(t(a(t(u(s[\s\S]*)?)?)?)?)?)?$/i;

// Pure: a reply's text without its status line, and the status it carried.
export function parseStatus(text: string): { text: string; status: SessionStatus | null } {
  let status: SessionStatus | null = null;
  const stripped = text.replace(MARKER_RE, (_all, tone: string, label: string) => {
    const l = label.replace(/\s+/g, ' ').trim();
    if (l) status = { tone: tone.toLowerCase() as StatusTone, label: l };
    return '';
  });
  return { text: stripped === text ? text : stripped.replace(/\s+$/, ''), status };
}

// Pure: what a panel shows of a reply — no status line, not even one that is
// still being streamed.
export function stripStatus(text: string): string {
  if (!text.includes('<!--')) return text;
  const { text: t } = parseStatus(text);
  const open = t.match(OPEN_TAIL_RE);
  if (open && OPEN_MARKER_RE.test(open[0])) return t.slice(0, open.index).replace(/\s+$/, '');
  return t;
}

// Pure: is the conversation stopped on a question for the user? True when the
// last thing said is a reply that ends with a needs-you status line.
export function awaitingUser(msgs: readonly { role: string; text?: string }[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') return false;
    if (m.role === 'assistant' && typeof m.text === 'string' && m.text.trim()) return parseStatus(m.text).status?.tone === 'needs-you';
  }
  return false;
}
