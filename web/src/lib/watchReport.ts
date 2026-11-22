// Model: Session.watches — a settled watch's report, as the server puts it
// into the session's conversation (server/src/watches.ts watchReport).
// Parsed here so the chat shows it as a card, not as something the user typed.

export type WatchReport = { label: string; state: 'met' | 'cannot be met' | 'timed out'; body: string };

export function parseWatchReport(text: string): WatchReport | null {
  const m = /^\[Watch "(.*?)" (met|cannot be met|timed out)\]\n\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  // The paragraphs after the facts are for the agent, not the reader.
  const body = m[3]
    .split('\n\n')
    .filter((p) => !/^(When you set this watch you planned to|You had planned, once it was met, to|The user has not replied since|Decide what to do:|Tell the user where things stand)/.test(p))
    .join('\n\n');
  return { label: m[1], state: m[2] as WatchReport['state'], body };
}

// What the server pushes about the watches of the open session.
export type WatchItem = { id: string; label: string; createdAt: number; deadline: number; lastSeen: string };
