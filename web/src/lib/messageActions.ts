// Model: web.MessageActions — the row that appears over a chat message on
// hover (like Devin's): when it was written, Copy (the Markdown source),
// Copy link (opens the session at this message) and Side chat (a side
// question about this reply).

// Pure: "10:45" today, "Nov 21 10:45" another day, with the year when it differs.
export function messageTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  return `${md} ${hm}`;
}

// Pure: the full date and time, for the tooltip.
export function messageTimeFull(at: number): string {
  return new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export type MessageLink = { projectId: string; sessionId: string; anchor: string };

// Pure: a link that opens `sessionId` in `projectId` scrolled to the message
// with `anchor` (the same anchors bookmarks and comments use). base: the
// app's address without a hash.
export function messageLink(base: string, l: MessageLink): string {
  const parts = [l.projectId, l.sessionId, l.anchor].map(encodeURIComponent).join('/');
  return `${base.replace(/#.*$/, '')}#msg=${parts}`;
}

// Pure: the message a location hash points at, or null.
export function messageLinkFromHash(hash: string): MessageLink | null {
  const m = /^#msg=([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
  if (!m) return null;
  try {
    const [projectId, sessionId, anchor] = [m[1], m[2], m[3]].map(decodeURIComponent);
    if (!projectId || !/^[0-9a-f-]{8,64}$/i.test(sessionId) || !/^[uat]:/.test(anchor)) return null;
    return { projectId, sessionId, anchor };
  } catch { return null; }
}

// Pure: a side-chat question about one message — the message quoted first
// (at most `cap` characters), then the question.
export function questionAbout(quote: string, question: string, cap = 6000): string {
  const q = quote.length > cap ? `${quote.slice(0, cap)}…` : quote;
  const quoted = q.split('\n').map((l) => `> ${l}`).join('\n');
  return `About this message from the conversation:\n\n${quoted}\n\n${question}`;
}
