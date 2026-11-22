// Model: web.SidePanel — the right-hand column as a workspace of its own
// (like Devin's): a strip of tabs with "+", maximize and collapse. A tab is
// one of a few tools; "+" opens a launcher tab that turns into the tool
// picked from it. One set of tabs per project, remembered on this device.

// target of a Changes tab: FOLLOW = whatever checkout the session the user
// is working in runs in; ROOT = the project directory; else a worktree name.
export const FOLLOW = '@follow';
export const ROOT = '@root';

// What a tab shows; a SideTab is one of these with an id.
export type SideWant =
  | { kind: 'changes'; target: string }
  | { kind: 'review' }
  // Model: SideChat (/btw) — a read-only side chat about a Claude session.
  // The tab is kept; the side chat's own memory lives on the server only
  // while the tab is connected (a reload starts a fresh copy).
  | { kind: 'btw'; sessionId: string; label: string }
  // Model: web.PreviewView — a dev server on this machine, by port; path is
  // where it was last (kept so the tab comes back to it).
  | { kind: 'preview'; port: number; path: string }
  // Model: web.SidePanel session tools — follow the session the user is in.
  | { kind: 'progress' }
  | { kind: 'agents' }
  | { kind: 'observe' }
  // The project's files, read beside the chat.
  | { kind: 'files' }
  | { kind: 'launcher' };
export type SideTab = SideWant & { id: string };
export type SideState = { tabs: SideTab[]; active: string | null };

let seq = 0;
export function sideTabId(): string { return `s${Date.now().toString(36)}${(seq++).toString(36)}`; }

export function defaultSideState(reviewOn: boolean, id = sideTabId): SideState {
  const changes: SideTab = { id: id(), kind: 'changes', target: FOLLOW };
  return { tabs: reviewOn ? [changes, { id: id(), kind: 'review' }] : [changes], active: changes.id };
}

// Review tabs only exist while the Review feature is on.
export function visibleTabs(s: SideState, reviewOn: boolean): SideTab[] {
  return reviewOn ? s.tabs : s.tabs.filter((t) => t.kind !== 'review');
}

// The tab to show: the active one if visible, else the first visible.
export function activeTab(s: SideState, reviewOn: boolean): SideTab | null {
  const vis = visibleTabs(s, reviewOn);
  return vis.find((t) => t.id === s.active) ?? vis[0] ?? null;
}

function same(a: SideTab, b: SideWant): boolean {
  if (a.kind === 'btw' || b.kind === 'btw') return a.kind === 'btw' && b.kind === 'btw' && a.sessionId === b.sessionId;
  if (a.kind === 'preview' || b.kind === 'preview') return a.kind === 'preview' && b.kind === 'preview' && a.port === b.port;
  if (a.kind === 'changes' || b.kind === 'changes') return a.kind === b.kind && a.kind === 'changes' && b.kind === 'changes' && a.target === b.target;
  return a.kind === b.kind;
}

export function activate(s: SideState, id: string): SideState {
  return s.tabs.some((t) => t.id === id) ? { ...s, active: id } : s;
}

// Focus the tab showing `want`, opening it (after the active tab) if there is none.
export function openTab(s: SideState, want: SideWant, id = sideTabId): SideState {
  const found = s.tabs.find((t) => same(t, want));
  if (found) return { ...s, active: found.id };
  const tab = { ...want, id: id() } as SideTab;
  const at = s.tabs.findIndex((t) => t.id === s.active);
  const tabs = [...s.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
  return { tabs, active: tab.id };
}

// "+" — always a fresh launcher tab at the end.
export function addLauncher(s: SideState, id = sideTabId): SideState {
  const tab: SideTab = { id: id(), kind: 'launcher' };
  return { tabs: [...s.tabs, tab], active: tab.id };
}

// A launcher turns into what was picked from it. If that tool is already
// open elsewhere, the launcher closes and that tab is focused instead.
export function pick(s: SideState, launcherId: string, want: SideWant): SideState {
  const existing = s.tabs.find((t) => t.id !== launcherId && same(t, want));
  if (existing) return { tabs: s.tabs.filter((t) => t.id !== launcherId), active: existing.id };
  return { ...s, tabs: s.tabs.map((t) => (t.id === launcherId ? ({ ...want, id: t.id } as SideTab) : t)), active: launcherId };
}

// Close a tab; the neighbour to its right (else left) becomes active.
export function closeTab(s: SideState, id: string): SideState {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const active = s.active !== id ? s.active : (tabs[i] ?? tabs[i - 1])?.id ?? null;
  return { tabs, active };
}

// Stored state from localStorage; anything malformed falls back to the default.
export function parseSideState(raw: string | null, reviewOn: boolean): SideState {
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.tabs)) {
      const tabs: SideTab[] = v.tabs.filter((t: any) =>
        t && typeof t.id === 'string' && (
          (t.kind === 'changes' && typeof t.target === 'string') || t.kind === 'review' || t.kind === 'launcher'
          || t.kind === 'progress' || t.kind === 'agents' || t.kind === 'observe' || t.kind === 'files'
          || (t.kind === 'btw' && typeof t.sessionId === 'string' && typeof t.label === 'string')
          || (t.kind === 'preview' && isPreviewPort(t.port) && typeof t.path === 'string')
        ));
      return { tabs, active: typeof v.active === 'string' ? v.active : tabs[0]?.id ?? null };
    }
  } catch {}
  return defaultSideState(reviewOn);
}

export function isPreviewPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535;
}

// A tab's own fields changed (a preview's path), without moving it.
export function updateTab(s: SideState, id: string, patch: Partial<SideWant>): SideState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as SideTab) : t)) };
}
