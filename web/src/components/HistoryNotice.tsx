// Model: web.HistoryNotice — said in place of an empty chat when a session's
// history could not be loaded (an HTTP error, or the server found nothing for
// a session that should have some), with a way to try again. A blank chat
// gave no hint that anything had gone wrong.
export function HistoryNotice({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="history-notice" role="status">
      <span>{text}</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

// What to tell the user about a transcript response; null = nothing wrong.
export function historyProblem(r: { ok: boolean; status: number } | null, events: number | null, total: number | null): string | null {
  if (!r) return "Couldn't reach the server to load this session's history.";
  if (!r.ok) return r.status === 404
    ? "This session's history was not found on the server."
    : `Couldn't load this session's history (HTTP ${r.status}).`;
  if (events === 0 && (total ?? 0) === 0) return 'No messages were found for this session.';
  return null;
}
