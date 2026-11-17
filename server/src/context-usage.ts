// Model: Claude Session.contextUsage — how full the live session's context
// window is, as the CLI's /context reports it. Read from the SDK control
// request getContextUsage({ detail: 'summary' }): answered from the last
// response's usage plus local estimates, so it costs no model or
// token-count calls (~30ms on a live query).

export type ContextCategory = {
  id: string;
  name: string;
  tokens: number;
  kind: 'used' | 'free' | 'buffer';
};

export type ContextSnapshot = {
  model: string;
  usedTokens: number;
  windowTokens: number;
  percent: number;
  // Where auto-compact kicks in (null when it is off or not reported).
  autoCompactAt: number | null;
  categories: ContextCategory[];
  fetchedAt: number;
};

// Accepts the SDK's SDKControlGetContextUsageResponse (typed loosely: the
// CLI adds fields over time, e.g. autoCompactThreshold isn't in the .d.ts).
export function mapContextUsage(r: any, now = Date.now()): ContextSnapshot | null {
  const used = Number(r?.totalTokens);
  // rawMaxTokens is the window the percentage is measured against (the
  // model's limit, or a smaller compaction-policy window).
  const windowTokens = Number(r?.rawMaxTokens ?? r?.maxTokens);
  if (!Number.isFinite(used) || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  const pct = Number(r?.percentage);
  const categories: ContextCategory[] = [];
  for (const c of Array.isArray(r?.categories) ? r.categories : []) {
    const tokens = Number(c?.tokens);
    // Deferred rows are out-of-window tool schemas: not part of the usage.
    if (c?.kind !== 'used' && c?.kind !== 'free' && c?.kind !== 'buffer') continue;
    if (c?.isDeferred || !Number.isFinite(tokens) || tokens <= 0) continue;
    categories.push({ id: String(c.id ?? c.name ?? ''), name: String(c.name ?? c.id ?? ''), tokens, kind: c.kind });
  }
  const auto = Number(r?.autoCompactThreshold);
  return {
    model: String(r?.model ?? ''),
    usedTokens: used,
    windowTokens,
    percent: Number.isFinite(pct) ? pct : Math.round((used / windowTokens) * 100),
    autoCompactAt: r?.isAutoCompactEnabled !== false && Number.isFinite(auto) && auto > 0 ? auto : null,
    categories,
    fetchedAt: now,
  };
}
