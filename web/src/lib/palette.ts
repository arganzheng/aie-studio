// Model: web.CommandPalette — Cmd/Ctrl+K: one search box over every
// session of every project (archived ones too), the projects, and a few
// actions. Pure helpers: what matches a query, in what order; and the tab
// Option+J / Option+K moves to.

export type PaletteGroup = 'Actions' | 'Projects' | 'Sessions';
export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  title: string;
  // Second line: project, state, age …
  detail: string;
  // Extra words the query may match (ids, kind, "archived" …).
  words?: string;
  // Sessions: newest first among equals.
  updatedAt?: number;
};

// Lower-cased query terms; every one must match somewhere.
export function terms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// How well `item` matches; null = it doesn't. Title matches beat detail
// matches, a title that starts with the first term beats the rest.
export function score(item: PaletteItem, ts: readonly string[]): number | null {
  if (ts.length === 0) return 0;
  const title = item.title.toLowerCase();
  const rest = `${item.detail} ${item.words ?? ''}`.toLowerCase();
  let s = 0;
  for (const t of ts) {
    if (title.includes(t)) s += 2;
    else if (rest.includes(t)) s += 1;
    else return null;
  }
  if (title.startsWith(ts[0])) s += 3;
  return s;
}

const GROUP_ORDER: Record<PaletteGroup, number> = { Actions: 0, Projects: 1, Sessions: 2 };

// The items to show for `q`, grouped (Actions, Projects, Sessions) and
// ranked inside each group; at most `limit` sessions.
export function search(items: readonly PaletteItem[], q: string, limit = 50): PaletteItem[] {
  const ts = terms(q);
  const hits = items
    .map((item) => ({ item, s: score(item, ts) }))
    .filter((h): h is { item: PaletteItem; s: number } => h.s !== null)
    .sort((a, b) =>
      GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group]
      || b.s - a.s
      || (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0));
  let sessions = 0;
  return hits.map((h) => h.item).filter((i) => i.group !== 'Sessions' || sessions++ < limit);
}

// Option+J (next) / Option+K (previous): the tab after / before the active
// one, wrapping round. null when there is nowhere to go.
export function cycleTab(ids: readonly string[], active: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const i = active ? ids.indexOf(active) : -1;
  if (i < 0) return ids[dir === 1 ? 0 : ids.length - 1];
  if (ids.length === 1) return null;
  return ids[(i + dir + ids.length) % ids.length];
}

// "3m", "5h", "2d" — how long ago, for a session's detail line.
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
