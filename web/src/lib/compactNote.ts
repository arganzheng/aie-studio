// What a compaction (/compact, or an automatic one) leaves in the
// conversation as user-role messages: the summary that replaces the earlier
// turns, the command as recorded, and its "Compacted" output. Neither was typed by the
// user, so the chat folds the first away and drops the others.
const SUMMARY_START = 'This session is being continued from a previous conversation that ran out of context.';

export type CompactNote = { kind: 'summary'; summary: string } | { kind: 'done' };

export function parseCompactNote(text: string): CompactNote | null {
  const t = text.trim();
  if (/^<local-command-stdout>\s*Compacted[^<]*<\/local-command-stdout>$/.test(t)) return { kind: 'done' };
  // The command itself, as the transcript records it.
  if (/^<command-name>\/compact<\/command-name>/.test(t)) return { kind: 'done' };
  if (!t.startsWith(SUMMARY_START)) return null;
  return { kind: 'summary', summary: t };
}
