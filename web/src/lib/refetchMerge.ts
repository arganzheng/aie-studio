// Model: web.SdkPanel history — the conversation fetched afresh (after a
// compaction rewrote it) replaces what the panel shows. Messages that came
// in while it was being fetched (a queued message sent the moment the
// compaction ended, the reply starting) are not in it yet: keep them after.

export type MergeMsg = { id: string; uuid?: string };

// Pure: `fetched` plus what arrived after the fetch began (not among
// `before`, the ids shown then) and is not in `fetched` already.
export function withArrivedDuring<M extends MergeMsg>(fetched: M[], current: readonly M[], before: ReadonlySet<string>): M[] {
  const have = new Set(fetched.map((m) => m.uuid).filter(Boolean));
  const arrived = current.filter((m) => !before.has(m.id) && !(m.uuid && have.has(m.uuid)));
  return arrived.length ? [...fetched, ...arrived] : fetched;
}
