// A line for the chat when a turn ends in a way the transcript does not
// show. Today: the session ran into the spending cap its parent's agent set
// (SDK result subtype error_max_budget_usd) — without a line it just stops.
export function resultNote(ev: unknown): string | null {
  const r = ev as { type?: unknown; subtype?: unknown; errors?: unknown } | null;
  if (r?.type !== 'result' || r.subtype !== 'error_max_budget_usd') return null;
  const first = Array.isArray(r.errors) ? r.errors.find((e): e is string => typeof e === 'string') : undefined;
  const amount = first ? /\$[0-9.]+/.exec(first)?.[0] : undefined;
  return `Stopped: this session reached the budget its parent session set${amount ? ` (${amount})` : ''}. Send a message to lift the limit and continue.`;
}
