// Model: Session.status — a short phrase the agent leaves when its turn ends,
// saying what the session is now waiting for: the user's decision
// ("needs-you") or the user's look at a finished deliverable ("ready"). The
// agent writes it as the last line of its reply, in an HTML comment, so a
// plain markdown view of the transcript shows nothing. The bridge reads it
// off the turn's result; the panels hide it.
//
// web/src/lib/sessionStatus.ts parses the same line for the chat panel.

export type StatusTone = 'needs-you' | 'ready';
export type SessionStatus = { tone: StatusTone; label: string };

export const STATUS_LABEL_MAX = 48;

// Given to the agent with the session's tools (an MCP server's instructions),
// so the session's own system prompt stays as it was.
export const STATUS_INSTRUCTIONS = [
  'Session status line. The user sees a list of their sessions with one short status phrase under each.',
  'When your turn ends and you are waiting for the user to decide, confirm or answer something before you can go on, end your final message with one last line of exactly this form: <!--status needs-you: Confirm scope-->',
  'When your turn ends with a deliverable for the user to look at (a pull request, a document, a page), use: <!--status ready: PR is ready-->',
  'The phrase is 2 to 4 English words, first word capitalised, that name the decision or the deliverable, whatever language the conversation is in. It is hidden from the reply itself, so say everything the user needs in the message as usual.',
  'Write no status line when neither applies (a plain answer, a progress note), and never more than one.',
].join(' ');

// Any tone is hidden (a model now and then invents one, e.g. "working"); only
// needs-you and ready count as a status.
const MARKER_RE = /<!--\s*status\s+([a-z][\w-]*)\s*:\s*([^\n]*?)\s*-->/gi;
// A marker still being streamed: an unclosed comment at the very end.
const OPEN_TAIL_RE = /<!--(?:(?!-->)[\s\S])*$/;

function cleanLabel(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > STATUS_LABEL_MAX ? `${t.slice(0, STATUS_LABEL_MAX - 1)}…` : t;
}

// Pure: a reply's text without its status line, and the status it carried
// (the last one, if the agent wrote several).
export function parseStatus(text: unknown): { text: string; status: SessionStatus | null } {
  if (typeof text !== 'string') return { text: '', status: null };
  let status: SessionStatus | null = null;
  const stripped = text.replace(MARKER_RE, (_all, tone: string, label: string) => {
    const l = cleanLabel(label);
    const t = tone.toLowerCase();
    if (l && (t === 'needs-you' || t === 'ready')) status = { tone: t, label: l };
    return '';
  });
  return { text: stripped === text ? text : stripped.replace(/\s+$/, ''), status };
}

// Pure: the same, for text that is still arriving — a half-written marker at
// the end is hidden too.
export function stripStatus(text: string): string {
  const { text: t } = parseStatus(text);
  const open = t.match(OPEN_TAIL_RE);
  if (open && /^<!--\s*(s(t(a(t(u(s[\s\S]*)?)?)?)?)?)?$/i.test(open[0])) return t.slice(0, open.index).replace(/\s+$/, '');
  return t;
}

// Pure: a stored status read back from disk.
export function normalizeStatus(raw: unknown): SessionStatus | null {
  const r = raw as { tone?: unknown; label?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  if (r.tone !== 'needs-you' && r.tone !== 'ready') return null;
  const label = typeof r.label === 'string' ? cleanLabel(r.label) : '';
  return label ? { tone: r.tone, label } : null;
}
