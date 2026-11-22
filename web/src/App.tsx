import { AutomationsDialog } from './components/AutomationsDialog';
import type React from 'react';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { cycleTab } from './lib/palette';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './components/FileTree';
import { ReviewPanel } from './components/ReviewPanel';
import { SidePanel, type SideRequest } from './components/SidePanel';
import type { FollowInfo } from './components/ChangesView';
import type { NewComment } from './components/CommentComposer';
import type { NewBookmark } from './components/BookmarkButton';
import type { Bookmark } from './types';
import * as review from './lib/review';
import type { ChatQuote } from './lib/addToChat';
import { alertHeadline, alertKey, alertSessionTitle, dropSeen, isViewing, titleWithUnread, upsertAlert, type SessionEvent, type ViewState } from './lib/sessionAlerts';
import { playChime, showSystemNotification } from './lib/sessionAlertEffects';
import { alertFromHash } from './lib/push';
import { useSessionEvents } from './useSessionEvents';
import { SessionAlerts } from './components/SessionAlerts';
import { InboxButton, InboxPanel } from './components/InboxPanel';
import { EMPTY_INBOX, INBOX_PAGE, markLocallyRead, removeLocally, unreadForSessions, viewedUnread, type InboxItem, type InboxState } from './lib/inbox';
import { SessionList } from './components/SessionList';
import { sessionRowKey, type SessionRow } from './lib/sessionList';
import { ProjectPicker } from './components/ProjectPicker';
import { ProjectManager } from './components/ProjectManager';
import { TabBar, tabTitle } from './components/TabBar';
import { Settings as SettingsModal } from './components/Settings';
import { DevinUsage } from './components/DevinUsage';
import { SessionPicker, type PickerItem } from './components/SessionPicker';
import { Login } from './components/Login';
import { DebugPanel } from './components/DebugPanel';
import { logDebug } from './lib/debugLog';
import { getTabKind, listTabKinds, type SessionPanelApi, type TabActivity } from './registry';
import { sameActivity } from './lib/tabActivity';
import {
  listProjects,
  addProject,
  updateProject,
  reorderProjects,
  deleteProject,
  getWorkspace,
  putProjectWorkspace,
  listResumableSessions,
  listDevinSessions,
  listSdkSessions,
  renameSdkSession,
  getSettings,
  putSettings,
  getAuthStatus,
  logout,
  type SubagentInfo,
  createWorktree,
  forkChildSession,
} from './api';
import { deleteNotifications, listNotifications, markNotificationsRead } from './api';
import { rewriteMovedPath } from './lib/movedPath';
import type { Project, Tab, Batch, Comment, TabRef, Workspace, ProjectWorkspace, Settings, LocalPrefs, ClaudeBridge } from './types';
import { tabRef, sameTabRef } from './types';
import { isStandalone } from './usePwaInstall';

const DEFAULT_SETTINGS: Settings = { sendKey: 'cmd-enter', theme: 'dark', fontScale: 'normal', model: '', devinModel: '', devinMode: '', devinVersion: '', showStderr: false, richCopy: false, review: false };

// Tabs with a prompt input (model: web.AddToChat / web.SendBatch targets).
function isSessionTab(tab: Tab): tab is Extract<Tab, { type: 'session' | 'claude-sdk' | 'devin' }> {
  return tab.type === 'session' || tab.type === 'claude-sdk' || tab.type === 'devin';
}

// Stable empty value so panels without comments don't re-render (model: web.HighlightQuotes).
const NO_COMMENT_MARKS: readonly review.CommentMark[] = [];
const NO_BOOKMARKED_ANCHORS: ReadonlySet<string> = new Set();

function randomId() { return Math.random().toString(36).slice(2, 10); }

// PWA (installed to home screen) and browser tabs use separate localStorage
// key namespaces so they have independent "last active project" memories.
// Rationale: on Android the two surfaces share the same origin partition,
// which would otherwise bleed browser activity into the PWA and vice versa;
// on iOS the platform already partitions storage per PWA install, so this
// only changes Android behavior in practice but keeps the code symmetric.
const IS_PWA = isStandalone();
const LS_PREFIX = IS_PWA ? 'remote-ide:pwa:' : 'remote-ide:browser:';
// Per-project active-tab pointer. Kept local so different windows can focus
// different tabs within the same project. The tabs list itself stays on the
// server (shared across windows).
const ACTIVE_LS_KEY = `${LS_PREFIX}active`;
// Device-local prefs (model: web entity Settings claudeBridge / showWireMenu).
const CLAUDE_BRIDGE_LS_KEY = `${LS_PREFIX}claudeBridge`;
const SHOW_WIRE_MENU_LS_KEY = `${LS_PREFIX}showWireMenu`;
const ENABLE_CLAUDE_LS_KEY = `${LS_PREFIX}enableClaude`;
const ENABLE_DEVIN_LS_KEY = `${LS_PREFIX}enableDevin`;
// Which list the left sidebar shows: the file tree or the Sessions view
// (a saved "groups", from when tab Groups existed, maps to Sessions).
const SIDEBAR_VIEW_LS_KEY = `${LS_PREFIX}sidebarView`;
// Desktop sidebar width (model: web.ResizeSidebar). null = CSS default (260px).
const SIDEBAR_WIDTH_LS_KEY = `${LS_PREFIX}sidebarWidth`;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;
// Desktop Review column (model: web.ResizeReviewPanel / web.ToggleReviewPanel).
const REVIEW_WIDTH_LS_KEY = `${LS_PREFIX}reviewWidth`;
const REVIEW_COLLAPSED_LS_KEY = `${LS_PREFIX}reviewCollapsed`;
// Model: web.SidePanel — the side panel covers the chat area (Maximize).
const SIDE_MAX_LS_KEY = `${LS_PREFIX}sideMaximized`;
const REVIEW_MIN_WIDTH = 200;
// Wide enough for side-by-side reading of a diff; Maximize goes further.
const REVIEW_MAX_WIDTH = 1400;
const REVIEW_COLLAPSED_WIDTH = 32;
// Which draft Batch new comments go to, per project (model:
// web.SetCurrentBatch). Per-device, like the active tab.
const REVIEW_CURRENT_BATCH_LS_KEY = `${LS_PREFIX}reviewCurrentBatch`;
type SidebarView = 'files' | 'sessions';
// Active project id. In browser mode the URL hash is authoritative and this
// is only written (never read on init). In PWA mode the URL hash is ignored
// on init — iOS "Add to Home Screen" often bakes the install-time hash into
// the launcher, which would otherwise pin every cold-start to that project —
// and this key is the sole source of truth for resuming.
const LAST_PROJECT_LS_KEY = `${LS_PREFIX}lastProjectId`;
// tabs: per-project active tab id. Per-device (localStorage) — the tab lists
// themselves live on the server.
type ActiveState = {
  projectId: string | null;
  tabs: Record<string, string | null>;
};

function loadLocalPrefs(): LocalPrefs {
  let claudeBridge: ClaudeBridge = 'sdk';
  let showWireMenu = false;
  let enableClaude = true;
  let enableDevin = true;
  try {
    if (localStorage.getItem(CLAUDE_BRIDGE_LS_KEY) === 'cli') claudeBridge = 'cli';
    showWireMenu = localStorage.getItem(SHOW_WIRE_MENU_LS_KEY) === '1';
    // Absent = enabled, so existing devices keep both providers.
    enableClaude = localStorage.getItem(ENABLE_CLAUDE_LS_KEY) !== '0';
    enableDevin = localStorage.getItem(ENABLE_DEVIN_LS_KEY) !== '0';
  } catch {}
  return { claudeBridge, showWireMenu, enableClaude, enableDevin };
}

function loadSidebarView(): SidebarView {
  try {
    const v = localStorage.getItem(SIDEBAR_VIEW_LS_KEY);
    return v === 'groups' || v === 'sessions' ? 'sessions' : 'files';
  } catch { return 'files'; }
}

function loadSidebarWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_LS_KEY));
    return Number.isFinite(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH ? n : null;
  } catch { return null; }
}

function loadReviewWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(REVIEW_WIDTH_LS_KEY));
    return Number.isFinite(n) && n >= REVIEW_MIN_WIDTH && n <= REVIEW_MAX_WIDTH ? n : null;
  } catch { return null; }
}

function loadReviewCollapsed(): boolean {
  try { return localStorage.getItem(REVIEW_COLLAPSED_LS_KEY) === '1'; } catch { return false; }
}

function loadCurrentBatches(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(REVIEW_CURRENT_BATCH_LS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function projectIdFromHash(): string | null {
  try {
    const h = decodeURIComponent(window.location.hash.slice(1));
    return h || null;
  } catch {
    return null;
  }
}

function loadActive(): { state: ActiveState; events: string[] } {
  const events: string[] = [];
  let tabs: Record<string, string | null> = {};
  try {
    const raw = localStorage.getItem(ACTIVE_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.tabs && typeof parsed.tabs === 'object' && !Array.isArray(parsed.tabs)) {
        tabs = parsed.tabs;
        const detail = Object.entries(tabs)
          .map(([pid, tid]) => `${pid}:${tid ?? 'null'}`)
          .join(', ');
        events.push(
          `restored active-tab map from localStorage (${Object.keys(tabs).length} project(s)${detail ? ` — ${detail}` : ''})`,
        );
      } else {
        events.push('active-tab map in localStorage has wrong shape, ignoring');
      }
    } else {
      events.push('no active-tab map in localStorage (first visit or cleared)');
    }
  } catch (e) {
    events.push(`failed to parse active-tab map: ${String(e)}`);
  }
  events.push(`storage mode: ${IS_PWA ? 'PWA' : 'browser'} (LS prefix "${LS_PREFIX}")`);
  let projectId: string | null = null;
  if (IS_PWA) {
    events.push('PWA standalone → ignoring URL hash on init (would otherwise pin to install-time hash)');
    try {
      const stored = localStorage.getItem(LAST_PROJECT_LS_KEY);
      if (stored) {
        projectId = stored;
        events.push(`resolved lastProjectId from localStorage: ${stored}`);
      } else {
        events.push('no lastProjectId in localStorage (first PWA launch or cleared)');
      }
    } catch (e) {
      events.push(`failed to read lastProjectId: ${String(e)}`);
    }
  } else {
    projectId = projectIdFromHash();
    if (projectId) {
      events.push(`active project from URL hash: ${projectId}`);
    } else {
      events.push('URL hash empty (browser mode has no fallback)');
    }
  }
  if (projectId) {
    if (projectId in tabs) {
      events.push(`stored active tab for project ${projectId}: ${tabs[projectId] ?? 'null'} (pending workspace validation)`);
    } else {
      events.push(`no stored active tab for project ${projectId} (not in map)`);
    }
  }
  return { state: { projectId, tabs }, events };
}

function saveActive(s: ActiveState) {
  // Persist only the per-browser bit. projectId is reflected to the hash by a
  // separate effect so we don't fight ourselves on hashchange.
  try { localStorage.setItem(ACTIVE_LS_KEY, JSON.stringify({ tabs: s.tabs })); } catch {}
}

function reconcileActive(
  prev: ActiveState,
  projects: Project[],
  workspace: Workspace,
): { next: ActiveState; events: string[]; changed: boolean } {
  const events: string[] = [];
  let projectId = prev.projectId;
  // Archived projects count as absent for the active pointer (model:
  // entity Project.archived / web.ArchiveProject): fall back to the first
  // visible one, same path as a deleted project.
  const projectExists = projectId && projects.some((p) => p.id === projectId && !p.archived);
  if (!projectExists) {
    const fallback = projects.find((p) => !p.archived)?.id ?? null;
    if (projectId !== fallback) {
      events.push(
        `active project ${projectId ?? 'null'} not in visible projects list → fallback to ${fallback ?? 'null'}`,
      );
    }
    projectId = fallback;
  }
  const tabs: Record<string, string | null> = {};
  const droppedProjects: string[] = [];
  for (const pid of Object.keys(prev.tabs)) {
    if (projects.some((p) => p.id === pid)) tabs[pid] = prev.tabs[pid];
    else droppedProjects.push(pid);
  }
  if (droppedProjects.length) {
    events.push(
      `dropped active-tab pointer for deleted project(s): ${droppedProjects.join(', ')}`,
    );
  }
  if (projectId) {
    const pw = workspace.projects[projectId];
    const list = pw?.tabs ?? [];
    const stored = tabs[projectId] ?? null;
    const hadEntry = projectId in tabs;
    const storedTab = stored ? list.find((t) => t.id === stored) ?? null : null;
    let nextTabId: string | null;
    if (storedTab) {
      nextTabId = storedTab.id;
      events.push(`project ${projectId} stored active tab ${stored} ✓ present in tabs list (${list.length} open) → keep`);
    } else {
      nextTabId = list[0]?.id ?? null;
      if (list.length === 0) {
        events.push(`project ${projectId} has 0 open tabs → active tab = null`);
      } else {
        events.push(
          `project ${projectId} stored active tab ${stored ?? 'null'} ${hadEntry ? '✗ not in tabs list' : '(none stored)'} → default to tabs[0] = ${nextTabId ?? 'null'} (${list.length} open)`,
        );
      }
    }
    tabs[projectId] = nextTabId;
  } else {
    events.push('no active project → active tab lookup skipped');
  }
  const changed =
    projectId !== prev.projectId ||
    JSON.stringify(tabs) !== JSON.stringify(prev.tabs);
  return { next: { projectId, tabs }, events, changed };
}

function setProjectHash(id: string | null) {
  const target = id ? `#${encodeURIComponent(id)}` : '';
  if (window.location.hash === target) return;
  if (!target && !window.location.hash) return;
  const url = window.location.pathname + window.location.search + target;
  history.replaceState(null, '', url);
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>({ projects: {} });
  const [{ state: initialActive, events: bootEvents }] = useState(() => loadActive());
  const [active, setActive] = useState<ActiveState>(initialActive);
  const [loaded, setLoaded] = useState(false);
  const [authState, setAuthState] = useState<{ required: boolean; authenticated: boolean; username?: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Mobile-only right drawer for Review (model: web.ReviewPanel). Desktop
  // renders the same panel as a permanent third column.
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState(false);
  const [appToast, setAppToast] = useState<string | null>(null);
  // Model: web.SessionAlerts — pending "finished / needs you" cards, oldest first.
  const [alerts, setAlerts] = useState<SessionEvent[]>([]);
  // Model: web.SessionList — bumped to make the Sessions view refetch now.
  const [sessionListSignal, setSessionListSignal] = useState(0);
  const unreadSessionKeys = useMemo(() => new Set(alerts.map(alertKey)), [alerts]);
  // Model: web.Inbox — the notification history; the column is closed until
  // the inbox button opens it.
  const [inboxOpen, setInboxOpen] = useState(false);
  const closeInbox = useCallback(() => setInboxOpen(false), []);
  const [inbox, setInbox] = useState<InboxState>(EMPTY_INBOX);
  const [inboxLoading, setInboxLoading] = useState(false);
  const inboxSeq = useRef(0);
  const inboxCount = useRef(0);
  inboxCount.current = inbox.items.length;
  // Re-read the newest page (as many rows as are loaded, so "Load older"
  // results don't vanish). A newer call wins over a slower older one.
  const refreshInbox = useCallback(async () => {
    const seq = ++inboxSeq.current;
    const limit = Math.min(200, Math.max(INBOX_PAGE, inboxCount.current));
    try {
      const r = await listNotifications({ limit });
      if (seq !== inboxSeq.current) return;
      setInbox({ items: r.items, unread: r.unread, hasMore: r.items.length >= limit });
    } catch {}
  }, []);
  const loadOlderInbox = useCallback(async () => {
    const last = inbox.items[inbox.items.length - 1];
    if (!last) return;
    const seq = ++inboxSeq.current;
    setInboxLoading(true);
    try {
      const r = await listNotifications({ before: last.at, limit: INBOX_PAGE });
      if (seq !== inboxSeq.current) return;
      setInbox((s) => ({ items: [...s.items, ...r.items.filter((i) => !s.items.some((x) => x.id === i.id))], unread: r.unread, hasMore: r.items.length >= INBOX_PAGE }));
    } catch {} finally { setInboxLoading(false); }
  }, [inbox.items]);
  const markInboxRead = useCallback((ids: string[] | 'all') => {
    if (ids !== 'all' && ids.length === 0) return;
    setInbox((s) => markLocallyRead(s, ids === 'all' ? 'all' : new Set(ids), Date.now()));
    void markNotificationsRead(ids === 'all' ? { all: true } : { ids }).catch(() => { void refreshInbox(); });
  }, [refreshInbox]);
  // Model: web.Inbox — dismissing a pop-up card (× or Clear all) counts as
  // seeing it. Marked by session on the server too, in case the row isn't in
  // the loaded page.
  const markInboxSessionsRead = useCallback((events: readonly SessionEvent[]) => {
    const withSession = events.filter((e) => e.sessionId);
    if (withSession.length === 0) return;
    const ids = new Set(unreadForSessions(inbox.items, withSession).map((i) => i.id));
    if (ids.size > 0) setInbox((s) => markLocallyRead(s, ids, Date.now()));
    void markNotificationsRead({ sessions: withSession.map((e) => ({ projectId: e.projectId, tabType: e.tabType, sessionId: e.sessionId! })) })
      .catch(() => { void refreshInbox(); });
  }, [inbox.items, refreshInbox]);
  const removeInboxItem = useCallback((item: InboxItem) => {
    setInbox((s) => removeLocally(s, item.id));
    void deleteNotifications({ ids: [item.id] }).catch(() => { void refreshInbox(); });
  }, [refreshInbox]);
  const clearInbox = useCallback(() => {
    setInbox(EMPTY_INBOX);
    void deleteNotifications({ all: true }).catch(() => { void refreshInbox(); });
  }, [refreshInbox]);
  const appToastTimer = useRef<number | null>(null);
  const showAppToast = useCallback((text: string) => {
    setAppToast(text);
    if (appToastTimer.current) window.clearTimeout(appToastTimer.current);
    appToastTimer.current = window.setTimeout(() => setAppToast(null), 2500);
  }, []);
  const [localPrefs, setLocalPrefs] = useState<LocalPrefs>(() => loadLocalPrefs());
  useEffect(() => {
    try {
      localStorage.setItem(CLAUDE_BRIDGE_LS_KEY, localPrefs.claudeBridge);
      localStorage.setItem(SHOW_WIRE_MENU_LS_KEY, localPrefs.showWireMenu ? '1' : '0');
      localStorage.setItem(ENABLE_CLAUDE_LS_KEY, localPrefs.enableClaude ? '1' : '0');
      localStorage.setItem(ENABLE_DEVIN_LS_KEY, localPrefs.enableDevin ? '1' : '0');
    } catch {}
  }, [localPrefs]);
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => loadSidebarView());
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_VIEW_LS_KEY, sidebarView); } catch {}
  }, [sidebarView]);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
  useEffect(() => {
    try {
      if (sidebarWidth == null) localStorage.removeItem(SIDEBAR_WIDTH_LS_KEY);
      else localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);
  // Drag state for the sidebar's right-edge handle; pointer capture keeps the
  // drag alive even when the cursor leaves the 6px bar.
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onSidebarResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sidebarDragRef.current = { startX: e.clientX, startW: panel.offsetWidth };
  };
  const onSidebarResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sidebarDragRef.current;
    if (!d) return;
    setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, d.startW + (e.clientX - d.startX))));
  };
  const onSidebarResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const [reviewWidth, setReviewWidth] = useState<number | null>(() => loadReviewWidth());
  useEffect(() => {
    try {
      if (reviewWidth == null) localStorage.removeItem(REVIEW_WIDTH_LS_KEY);
      else localStorage.setItem(REVIEW_WIDTH_LS_KEY, String(reviewWidth));
    } catch {}
  }, [reviewWidth]);
  const [reviewCollapsed, setReviewCollapsed] = useState<boolean>(() => loadReviewCollapsed());
  useEffect(() => {
    try { localStorage.setItem(REVIEW_COLLAPSED_LS_KEY, reviewCollapsed ? '1' : '0'); } catch {}
  }, [reviewCollapsed]);
  // Model: web.SidePanel — Maximize, and asks to show a tab (Review / a new launcher).
  const [sideMax, setSideMax] = useState<boolean>(() => { try { return localStorage.getItem(SIDE_MAX_LS_KEY) === '1'; } catch { return false; } });
  useEffect(() => {
    try { localStorage.setItem(SIDE_MAX_LS_KEY, sideMax ? '1' : '0'); } catch {}
  }, [sideMax]);
  const [sideRequest, setSideRequest] = useState<SideRequest | null>(null);
  const askSide = (kind: SideRequest['kind']) => setSideRequest((prev) => ({ kind, seq: (prev?.seq ?? 0) + 1 }));
  // Comments and bookmarks land in Review: bring its tab forward.
  const showReview = () => { setReviewCollapsed(false); askSide('review'); };
  // Model: web.CommandPalette — Cmd/Ctrl+K opens it; Option+J / Option+K move
  // to the next / previous tab of the project (read through a ref: the
  // listener is registered once).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const tabCycleRef = useRef<{ pid: string | null; ids: string[]; active: string | null }>({ pid: null, ids: [], active: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.code === 'KeyJ' || e.code === 'KeyK')) {
        const { pid, ids, active } = tabCycleRef.current;
        const next = cycleTab(ids, active, e.code === 'KeyJ' ? 1 : -1);
        if (!pid || !next) return;
        e.preventDefault();
        setActiveSelectionRef.current(pid, next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // Model: web.SidePanel — Option+T: a new launcher tab in the side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.code !== 'KeyT') return;
      e.preventDefault();
      setReviewCollapsed(false);
      setDrawerOpen(false);
      setReviewDrawerOpen(true);
      askSide('launcher');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const [currentBatches, setCurrentBatches] = useState<Record<string, string>>(() => loadCurrentBatches());
  useEffect(() => {
    try { localStorage.setItem(REVIEW_CURRENT_BATCH_LS_KEY, JSON.stringify(currentBatches)); } catch {}
  }, [currentBatches]);
  // Drag bar on the Review panel's *left* edge: moving the pointer left grows it.
  const reviewDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onReviewResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    reviewDragRef.current = { startX: e.clientX, startW: panel.offsetWidth };
  };
  const onReviewResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = reviewDragRef.current;
    if (!d) return;
    setReviewWidth(Math.min(REVIEW_MAX_WIDTH, Math.max(REVIEW_MIN_WIDTH, d.startW - (e.clientX - d.startX))));
  };
  const onReviewResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!reviewDragRef.current) return;
    reviewDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // Latest workspace for event handlers that need the current tab lists
  // without threading it through every call site.
  const workspaceRef = useRef<Workspace>(workspace);
  workspaceRef.current = workspace;
  const [refreshKey, setRefreshKey] = useState<Record<string, number>>({});
  // Lazy-mount: tabs only mount when they first become active. Once mounted,
  // they stay mounted (and hidden with display:none) so switching back is
  // instant. Otherwise a workspace with 77 devin tabs would open 77 WSes and
  // hit 77 transcript endpoints at boot.
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set());
  const exportApiRef = useRef<Map<string, { open: () => void; canExport: boolean }>>(new Map());
  const [exportApiVersion, setExportApiVersion] = useState(0);
  const registerExportApi = useCallback(
    (tabId: string, api: { open: () => void; canExport: boolean } | null) => {
      if (api) exportApiRef.current.set(tabId, api);
      else exportApiRef.current.delete(tabId);
      setExportApiVersion((n) => n + 1);
    },
    [],
  );
  // Per-tab session panel APIs (model: web.RevealMessage /
  // web.InsertBatchPrompt). A jump / send that has to open or lazy-mount a
  // tab parks its request in pendingReveal / pendingInsert until that tab's
  // panel registers.
  const panelApiRef = useRef<Map<string, SessionPanelApi>>(new Map());
  const pendingRevealRef = useRef<{ tabId: string; anchor: string } | null>(null);
  const pendingInsertRef = useRef<{ tabId: string; text: string; batchId?: string } | null>(null);
  // Model: web.AddToChat — quotes for a session panel that isn't mounted yet.
  const pendingQuotesRef = useRef<{ tabId: string; quotes: ChatQuote[] } | null>(null);
  const fireReveal = useCallback((tabId: string, anchor: string) => {
    const api = panelApiRef.current.get(tabId);
    if (!api) return false;
    pendingRevealRef.current = null;
    logDebug('review', `reveal ${anchor} in tab ${tabId}`);
    api.reveal(anchor).then((found) => {
      if (!found) showAppToast('Message not found in this session');
    });
    return true;
  }, [showAppToast]);
  const fireInsert = useCallback((tabId: string, text: string, batchId?: string) => {
    const api = panelApiRef.current.get(tabId);
    if (!api) return false;
    pendingInsertRef.current = null;
    logDebug('review', `insert ${batchId ? `batch ${batchId}` : 'quote'} into tab ${tabId} (${text.length} chars)`);
    api.insertPrompt(text, batchId);
    return true;
  }, []);
  // Model: web.CloseTab — per-tab "may I close?" guards (EditorPanel).
  const closeGuardRef = useRef<Map<string, () => boolean>>(new Map());
  const registerCloseGuard = useCallback((tabId: string, guard: (() => boolean) | null) => {
    if (guard) closeGuardRef.current.set(tabId, guard);
    else closeGuardRef.current.delete(tabId);
  }, []);
  const registerPanelApi = useCallback((tabId: string, api: SessionPanelApi | null) => {
    if (api) panelApiRef.current.set(tabId, api);
    else panelApiRef.current.delete(tabId);
    if (!api) return;
    const reveal = pendingRevealRef.current;
    if (reveal && reveal.tabId === tabId) fireReveal(tabId, reveal.anchor);
    const insert = pendingInsertRef.current;
    if (insert && insert.tabId === tabId) fireInsert(tabId, insert.text, insert.batchId);
    const quotes = pendingQuotesRef.current;
    if (quotes && quotes.tabId === tabId) {
      pendingQuotesRef.current = null;
      api.addQuotes(quotes.quotes);
    }
  }, [fireReveal, fireInsert]);
  // Model: web.TabActivityMarkers rule-311. Mounted session panels report
  // generating / awaitingInput; TabBar renders the markers.
  const [tabActivity, setTabActivity] = useState<Record<string, TabActivity>>({});
  const reportActivity = useCallback((tabId: string, activity: TabActivity | null) => {
    setTabActivity((cur) => {
      if (!activity) {
        if (!(tabId in cur)) return cur;
        const { [tabId]: _gone, ...rest } = cur;
        return rest;
      }
      if (sameActivity(cur[tabId], activity)) return cur;
      return { ...cur, [tabId]: activity };
    });
  }, []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [devinUsageOpen, setDevinUsageOpen] = useState(false);
  // Model: web.ProjectManager dialog.
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [picker, setPicker] = useState<{
    title: string;
    items: PickerItem[];
    onPick: (id: string) => void;
  } | null>(null);

  // Initial load — guarded so strict-mode double-mount doesn't double-fire
  // network calls or duplicate debug events.
  const bootRanRef = useRef(false);
  useEffect(() => {
    if (bootRanRef.current) return;
    bootRanRef.current = true;
    for (const msg of bootEvents) logDebug('init', msg);
    (async () => {
      const auth = await getAuthStatus();
      logDebug(
        'auth',
        `required=${auth.required} authenticated=${auth.authenticated}${auth.username ? ` username=${auth.username}` : ''}`,
      );
      setAuthState(auth);
      if (auth.required && !auth.authenticated) {
        logDebug('auth', 'not authenticated → showing login');
        return;
      }
      const [ps, ws, st] = await Promise.all([listProjects(), getWorkspace(), getSettings()]);
      logDebug(
        'load',
        `projects: ${ps.length} (${ps.map((p) => p.id).join(', ') || 'none'})`,
      );
      const wsProjectIds = Object.keys(ws.projects || {});
      const totalTabs = wsProjectIds.reduce(
        (n, pid) => n + (ws.projects[pid]?.tabs?.length ?? 0),
        0,
      );
      logDebug(
        'load',
        `workspace: ${wsProjectIds.length} project(s), ${totalTabs} tab(s) total`,
      );
      logDebug(
        'load',
        `settings: theme=${st.theme} fontScale=${st.fontScale} sendKey=${st.sendKey} model=${st.model || '(default)'} devinModel=${st.devinModel || '(default)'} devinMode=${st.devinMode || '(default)'} showStderr=${st.showStderr ?? false} richCopy=${st.richCopy ?? false} review=${st.review ?? false}`,
      );
      setProjects(ps);
      setWorkspace(ws);
      setSettings(st);
      // Summarize devin/chat tabs at boot; only dump per-tab detail for the
      // ones missing resumeId, which is the signal we care about when a tab
      // renders blank.
      let devinTotal = 0;
      let chatTotal = 0;
      const missing: Array<{ kind: 'devin' | 'chat'; pid: string; id: string; title?: string }> = [];
      for (const [pid, pws] of Object.entries(ws.projects || {})) {
        for (const t of pws.tabs || []) {
          if (t.type !== 'devin' && t.type !== 'session') continue;
          if (t.type === 'devin') devinTotal++;
          else chatTotal++;
          if (!t.resumeId) {
            missing.push({ kind: t.type === 'devin' ? 'devin' : 'chat', pid, id: t.id, title: t.title });
          }
        }
      }
      logDebug(
        'load',
        `boot tabs: devin=${devinTotal} chat=${chatTotal} missingResumeId=${missing.length}`,
      );
      for (const { kind, pid, id, title } of missing) {
        logDebug(
          `${kind}:tab`,
          `boot missing resumeId: project=${pid} tab=${id} title=${JSON.stringify(title ?? null)}`,
        );
      }
      setLoaded(true);
      logDebug('load', 'boot complete, entering reconcile phase');
    })();
  }, []);

  function updateSettings(next: Settings) {
    setSettings(next);
    putSettings(next);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.fontScale = settings.fontScale;
  }, [settings.fontScale]);

  // Per-project debounced persistence. Each project has its own timer +
  // pending payload so writes to project A never carry stale project B state
  // in the same request — this was the root cause of multi-window tab-loss
  // (two windows both PUTting the whole workspace clobbered each other).
  // Timers are flushed on page unload via keepalive fetch so the last write
  // in the debounce window still reaches the server if the user closes fast.
  const projectSaveTimers = useRef<Map<string, number>>(new Map());
  const projectSavePayloads = useRef<Map<string, ProjectWorkspace>>(new Map());
  const flushProjectSave = useCallback((pid: string) => {
    const timer = projectSaveTimers.current.get(pid);
    if (timer) window.clearTimeout(timer);
    projectSaveTimers.current.delete(pid);
    const pw = projectSavePayloads.current.get(pid);
    projectSavePayloads.current.delete(pid);
    if (pw) putProjectWorkspace(pid, pw);
  }, []);
  const saveProjectWorkspace = useCallback((projectId: string, pw: ProjectWorkspace) => {
    // Keep the ref current right away: two saves in one event (a panel's send
    // retitles its tab, then marks a Review Batch sent) each rebuild the slot
    // from workspaceRef and must not drop the other's change.
    workspaceRef.current = {
      ...workspaceRef.current,
      projects: { ...workspaceRef.current.projects, [projectId]: pw },
    };
    setWorkspace((ws) => ({
      ...ws,
      projects: { ...ws.projects, [projectId]: pw },
    }));
    projectSavePayloads.current.set(projectId, pw);
    const existing = projectSaveTimers.current.get(projectId);
    if (existing) window.clearTimeout(existing);
    projectSaveTimers.current.set(
      projectId,
      window.setTimeout(() => flushProjectSave(projectId), 250),
    );
  }, [flushProjectSave]);

  // Flush any pending per-project saves before the page unloads. Both events
  // for cross-browser coverage: pagehide fires reliably on mobile Safari
  // (where beforeunload is unreliable), beforeunload fires on desktop.
  // keepalive: true lets the request survive tab teardown.
  useEffect(() => {
    const flush = () => {
      for (const [pid, timer] of projectSaveTimers.current.entries()) {
        window.clearTimeout(timer);
        const pw = projectSavePayloads.current.get(pid);
        if (pw) {
          try {
            fetch(`/api/workspace/projects/${encodeURIComponent(pid)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(pw),
              keepalive: true,
            });
          } catch {}
        }
      }
      projectSaveTimers.current.clear();
      projectSavePayloads.current.clear();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // Persist active state synchronously so a quick refresh doesn't lose it.
  // Deps are narrowed to `active.tabs` — setActiveProject preserves the tabs
  // reference so it won't spuriously refire this effect. First mount is
  // skipped because the initial state was just read from localStorage:
  // writing it back would be a redundant round-trip.
  const persistMountedRef = useRef(false);
  useEffect(() => {
    if (!persistMountedRef.current) {
      persistMountedRef.current = true;
      return;
    }
    saveActive(active);
    const summary = Object.entries(active.tabs)
      .map(([pid, tid]) => `${pid}:${tid ?? 'null'}`)
      .join(', ');
    logDebug('persist', `wrote active-tab map to localStorage (${Object.keys(active.tabs).length} project(s)${summary ? ` — ${summary}` : ''})`);
  }, [active.tabs]);

  // Reflect active project to the URL hash so it's shareable / survives copy.
  // lastProjectId is PWA-only: browser mode never reads it back (URL hash is
  // the source of truth) so writing it there would be dead I/O.
  useEffect(() => {
    const before = window.location.hash;
    setProjectHash(active.projectId);
    const after = window.location.hash;
    if (before !== after) {
      logDebug('persist', `URL hash: "${before || '(empty)'}" → "${after || '(empty)'}"`);
    }
    if (!IS_PWA) return;
    try {
      if (active.projectId) {
        localStorage.setItem(LAST_PROJECT_LS_KEY, active.projectId);
        logDebug('persist', `wrote lastProjectId = ${active.projectId}`);
      } else {
        localStorage.removeItem(LAST_PROJECT_LS_KEY);
        logDebug('persist', 'cleared lastProjectId');
      }
    } catch (e) {
      logDebug('persist', `failed to write lastProjectId: ${String(e)}`);
    }
  }, [active.projectId]);

  // Track external hash edits (back/forward, manual edit, paste of a deep link).
  useEffect(() => {
    function onHash() {
      const next = projectIdFromHash();
      setActive((a) => {
        if (a.projectId === next) {
          logDebug('hash', `hashchange → ${next ?? 'null'} (no change)`);
          return a;
        }
        logDebug('hash', `hashchange: active project ${a.projectId ?? 'null'} → ${next ?? 'null'}`);
        return { ...a, projectId: next };
      });
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Reconcile stored active state against actual data once both projects and
  // workspace have loaded — clears stale ids pointing at deleted projects /
  // closed tabs, falling back to the first available.
  const activeProjectId = active.projectId;
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const projectWs = activeProjectId ? workspace.projects[activeProjectId] : undefined;
  const tabs: Tab[] = projectWs?.tabs ?? [];
  const batches: Batch[] = projectWs?.batches ?? [];
  const bookmarks: Bookmark[] = projectWs?.bookmarks ?? [];
  const activeTabId = activeProjectId ? (active.tabs[activeProjectId] ?? null) : null;

  // Narrow signatures for the reconcile effect. Depending on the full
  // `workspace` / `active` objects makes reconcile fire on every onTitle /
  // onSessionId write, even when the tab-id set hasn't changed — reconcile
  // then no-ops but still runs + logs. These sigs change only when the
  // inputs reconcile actually cares about change.
  // Archived flag is part of the signature: archiving the active project must
  // re-run reconcile so it falls back to a visible one (model: web.ArchiveProject).
  const projectIdsSig = useMemo(
    () => projects.map((p) => `${p.id}${p.archived ? '!' : ''}`).join('\0'),
    [projects],
  );
  const activeTabsSig = useMemo(() => {
    if (!activeProjectId) return '';
    return (workspace.projects[activeProjectId]?.tabs ?? []).map((t) => t.id).join('\0');
  }, [workspace, activeProjectId]);
  const activeTabsMapKeysSig = useMemo(
    () => Object.keys(active.tabs).sort().join('\0'),
    [active.tabs],
  );

  // Reconcile stored active state against actual data once both projects and
  // workspace have loaded — clears stale ids pointing at deleted projects /
  // closed tabs, falling back to the first available.
  // The ref suppresses the immediate follow-up run caused by our own setActive
  // in the previous cycle — that second run would just re-validate the tab we
  // just wrote and log a spurious "keep". A user-driven setActive still runs
  // normally because the ref was cleared on the last cycle.
  const reconcileSelfRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (reconcileSelfRef.current) {
      reconcileSelfRef.current = false;
      return;
    }
    const { next, events, changed } = reconcileActive(active, projects, workspace);
    for (const msg of events) logDebug('reconcile', msg);
    if (changed) {
      reconcileSelfRef.current = true;
      setActive(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, projectIdsSig, activeProjectId, activeTabId, activeTabsSig, activeTabsMapKeysSig]);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeExport = useMemo(
    () => (activeTabId ? exportApiRef.current.get(activeTabId) ?? null : null),
    [activeTabId, exportApiVersion],
  );

  // Reflect the active project name into the browser tab title so users with
  // multiple windows open can tell them apart from the OS tab strip.
  useEffect(() => {
    document.title = titleWithUnread(activeProject ? `${activeProject.name} — AI Studio` : 'AI Studio', alerts.length);
  }, [activeProject, alerts.length]);

  // Model: web.SessionAlerts — what the user is looking at, for deciding
  // whether an event is news. Refs: the socket callback outlives renders.
  const viewState = (): ViewState => ({
    attending: document.visibilityState === 'visible' && document.hasFocus(),
    activeProjectId,
    activeTab: activeTab && isSessionTab(activeTab) ? activeTab : null,
  });
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const describeAlert = (e: SessionEvent) => ({
    event: e,
    title: alertSessionTitle(e, workspace.projects[e.projectId]?.tabs ?? []),
    project: projects.find((p) => p.id === e.projectId)?.name ?? '',
  });
  const describeAlertRef = useRef(describeAlert);
  describeAlertRef.current = describeAlert;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const openSessionAlertRef = useRef<(e: SessionEvent) => void>(() => {});
  const onSessionEvent = useCallback((e: SessionEvent) => {
    // Model: web.SessionList — any session event means the list is stale.
    setSessionListSignal((n) => n + 1);
    // Model: web.Inbox — the server has stored it; fetch the new row.
    void refreshInbox();
    const view = viewStateRef.current();
    if (isViewing(e, view)) return;
    setAlerts((prev) => upsertAlert(prev, e));
    const s = settingsRef.current;
    if (s.notifySound ?? true) playChime(e.kind);
    if (s.notifySystem && !view.attending) {
      const d = describeAlertRef.current(e);
      void showSystemNotification(
        { title: d.title, body: `${alertHeadline(e.kind)}${d.project ? ` · ${d.project}` : ''}`, tag: alertKey(e), data: e },
        () => openSessionAlertRef.current(e),
      );
    }
  }, []);
  const signedIn = !!authState && (!authState.required || authState.authenticated);
  useSessionEvents(signedIn && (settings.notify ?? true), onSessionEvent, refreshInbox);
  useEffect(() => { if (signedIn) void refreshInbox(); }, [signedIn, refreshInbox]);
  // Model: web.Inbox — looking at a session marks its notification read, the
  // same moment its pop-up card goes away.
  useEffect(() => {
    const sweep = () => markInboxRead(viewedUnread(inbox.items, viewStateRef.current()).map((i) => i.id));
    sweep();
    window.addEventListener('focus', sweep);
    document.addEventListener('visibilitychange', sweep);
    return () => {
      window.removeEventListener('focus', sweep);
      document.removeEventListener('visibilitychange', sweep);
    };
  }, [activeProjectId, activeTab, inbox.items, markInboxRead]);
  // Going to a session on your own clears its alert; so does coming back to
  // the page while it is the one on screen.
  useEffect(() => {
    const sweep = () => setAlerts((prev) => dropSeen(prev, viewStateRef.current()) as SessionEvent[]);
    sweep();
    window.addEventListener('focus', sweep);
    document.addEventListener('visibilitychange', sweep);
    return () => {
      window.removeEventListener('focus', sweep);
      document.removeEventListener('visibilitychange', sweep);
    };
  }, [activeProjectId, activeTab]);
  // A clicked system notification comes back through the service worker.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (m: MessageEvent) => {
      if (m.data?.type === 'session-alert-open' && m.data.event?.projectId) openSessionAlertRef.current(m.data.event as SessionEvent);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);
  // Model: server.WebPush — a notification clicked while the app was closed
  // opens it at /#alert=<event> (sw.js): go to that session once loaded.
  useEffect(() => {
    if (!loaded) return;
    const e = alertFromHash(window.location.hash) as SessionEvent | null;
    if (!e?.projectId) return;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    openSessionAlertRef.current(e);
  }, [loaded]);

  // Model: web.AddToChat — the session tab the user was last in, per project:
  // where a passage quoted from a file goes.
  const lastSessionTabRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (activeProjectId && activeTab && isSessionTab(activeTab)) lastSessionTabRef.current.set(activeProjectId, activeTab.id);
  }, [activeProjectId, activeTab]);

  // Model: web.SidePanel — the session a "follow" Changes tab shows: the one
  // in front, else the one the user was last in. Claude sessions are looked
  // up by id (the server knows which worktree each runs in); a fresh child
  // tab names its worktree before it has an id. Devin runs in the project.
  const lastSessionId = activeProjectId ? lastSessionTabRef.current.get(activeProjectId) : undefined;
  const followCandidate = activeTab && isSessionTab(activeTab) ? activeTab : tabs.find((t) => t.id === lastSessionId) ?? null;
  const followTab = followCandidate && isSessionTab(followCandidate) ? followCandidate : null;
  const followTitle = followTab ? (('title' in followTab && followTab.title) || tabTitle(followTab)) : '';
  const followSessionId = followTab && followTab.type !== 'devin' ? followTab.resumeId : undefined;
  const followWorktree = followTab?.type === 'claude-sdk' ? followTab.worktree : undefined;
  const follow: FollowInfo | null = useMemo(
    () => (followTab ? { sessionId: followSessionId, worktree: followWorktree, label: followTitle } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followTab?.id, followSessionId, followWorktree, followTitle],
  );

  // Record that a tab was visited so lazy-mount keeps it alive after the
  // first switch away. Fires whenever the active tab id changes.
  useEffect(() => {
    if (!activeTabId) return;
    setVisitedTabs((prev) => {
      if (prev.has(activeTabId)) return prev;
      const next = new Set(prev);
      next.add(activeTabId);
      logDebug('tab', `visited tabs +${activeTabId} (${next.size} mounted)`);
      return next;
    });
  }, [activeTabId]);

  function setActiveProject(id: string) {
    setActive((a) => {
      if (a.projectId === id) {
        logDebug('nav', `setActiveProject(${id}) — already active, no-op`);
        return a;
      }
      logDebug('nav', `setActiveProject: ${a.projectId ?? 'null'} → ${id}`);
      return { ...a, projectId: id };
    });
  }

  // For listeners registered once (Option+J / Option+K).
  const setActiveSelectionRef = useRef<(projectId: string, tabId: string | null) => void>(() => {});
  function setActiveSelection(projectId: string, tabId: string | null) {
    setActive((a) => {
      const prevTab = a.tabs[projectId] ?? null;
      if (prevTab === tabId) {
        logDebug('nav', `setActiveSelection(${projectId}, ${tabId ?? 'null'}) — already active, no-op`);
        return a;
      }
      logDebug('nav', `setActiveSelection: project ${projectId} tab ${prevTab ?? 'null'} → ${tabId ?? 'null'}`);
      return { ...a, tabs: { ...a.tabs, [projectId]: tabId } };
    });
  }

  function setActiveTab(projectId: string, tabId: string | null, tabList?: Tab[]) {
    const list = tabList ?? workspaceRef.current.projects[projectId]?.tabs ?? [];
    const tab = tabId ? list.find((t) => t.id === tabId) : undefined;
    setActiveSelection(projectId, tab ? tab.id : null);
  }

  function updateProjectTabs(projectId: string, nextTabs: Tab[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: nextTabs, batches: current?.batches ?? [], bookmarks: current?.bookmarks ?? [] });
  }

  function updateProjectBatches(projectId: string, nextBatches: Batch[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], batches: nextBatches, bookmarks: current?.bookmarks ?? [] });
  }

  function updateProjectBookmarks(projectId: string, nextBookmarks: Bookmark[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], batches: current?.batches ?? [], bookmarks: nextBookmarks });
  }

  function openFileTab(filePath: string) {
    if (!activeProjectId) {
      logDebug('tab', `openFileTab(${filePath}) ignored — no active project`);
      return;
    }
    const existing = tabs.find((t) => t.type === 'file' && t.path === filePath);
    if (existing) {
      logDebug('tab', `openFileTab: file ${filePath} already open (tab ${existing.id}), activating`);
      setActiveTab(activeProjectId, existing.id);
      return;
    }
    const tab: Tab = { id: randomId(), type: 'file', path: filePath };
    logDebug('tab', `openFileTab: new file tab ${tab.id} for ${filePath} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
  }

  // Returns the (existing or new) tab id so callers like JumpToComment can
  // target it.
  function openSessionTab(resumeId?: string, title?: string, opts: { wire?: boolean } = {}): string | undefined {
    if (!activeProjectId) {
      logDebug('tab', 'openSessionTab ignored — no active project');
      return;
    }
    // Resume of an already-open session: activate the existing tab instead of
    // duplicating. Two tabs on the same sessionId share one server-side entry
    // and just confuse the user (typing in one updates state in the other).
    if (resumeId) {
      const existing = tabs.find((t) => t.type === 'session' && t.resumeId === resumeId);
      if (existing) {
        logDebug('tab', `openSessionTab: session ${resumeId} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return existing.id;
      }
      // OpenTab cross-kind dedupe (Claude Session invariant): already open
      // as an SDK tab → go there instead of starting a second process.
      const other = tabs.find((t) => t.type === 'claude-sdk' && t.resumeId === resumeId);
      if (other) {
        logDebug('tab', `openSessionTab: session ${resumeId} already open as claude-sdk (tab ${other.id}), activating`);
        setActiveTab(activeProjectId, other.id);
        return other.id;
      }
    }
    const d = new Date();
    const defaultTitle = `Chat ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tab: Tab = { id: randomId(), type: 'session', resumeId, title: title || defaultTitle, ...(opts.wire ? { wire: true } : {}) };
    logDebug('tab', `openSessionTab: new session tab ${tab.id}${resumeId ? ` (resume ${resumeId})` : ' (fresh)'} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
    return tab.id;
  }

  // Model: web.SdkChatPanel / web.SdkSessionPicker — the Agent-SDK Claude
  // tab. Same dedupe-by-resumeId as openSessionTab; the two kinds are kept
  // apart (a session already open as `session` opens again as `claude-sdk`).
  function openSdkTab(resumeId?: string, title?: string, opts: { wire?: boolean; parentSessionId?: string; worktree?: string } = {}): string | undefined {
    if (!activeProjectId) {
      logDebug('tab', 'openSdkTab ignored — no active project');
      return;
    }
    if (resumeId) {
      const existing = tabs.find((t) => t.type === 'claude-sdk' && t.resumeId === resumeId);
      if (existing) {
        logDebug('tab', `openSdkTab: session ${resumeId} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return existing.id;
      }
      // OpenTab cross-kind dedupe (Claude Session invariant): already open
      // as a classic Claude tab → go there instead of starting a second process.
      const other = tabs.find((t) => t.type === 'session' && t.resumeId === resumeId);
      if (other) {
        logDebug('tab', `openSdkTab: session ${resumeId} already open as session (tab ${other.id}), activating`);
        setActiveTab(activeProjectId, other.id);
        return other.id;
      }
    }
    const d = new Date();
    const defaultTitle = `SDK ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tab: Tab = { id: randomId(), type: 'claude-sdk', resumeId, title: title || defaultTitle, ...(opts.wire ? { wire: true } : {}), ...(opts.parentSessionId && !resumeId ? { parentSessionId: opts.parentSessionId } : {}), ...(opts.worktree && !resumeId ? { worktree: opts.worktree } : {}) };
    logDebug('tab', `openSdkTab: new claude-sdk tab ${tab.id}${resumeId ? ` (resume ${resumeId})` : ' (fresh)'} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
    return tab.id;
  }

  // Model: web.RenameSdkSession — persistent name via the SDK (custom-title
  // record), reflected on the tab right away.
  async function renameSdkTab(tab: Tab) {
    if (tab.type !== 'claude-sdk' || !tab.resumeId || !activeProjectId) return;
    const next = window.prompt('Session name', tab.title ?? '');
    if (next == null) return;
    const title = next.trim();
    if (!title) return;
    try {
      await renameSdkSession(activeProjectId, tab.resumeId, title);
      const pid = activeProjectId;
      const live = workspaceRef.current.projects[pid]?.tabs ?? [];
      updateProjectTabs(pid, live.map((x) => (x.id === tab.id ? { ...x, title } : x)));
    } catch (e: any) {
      alert(`Rename failed: ${e?.message ?? e}`);
    }
  }

  // Resume (rule-078 / rule-378): a session whose process is still live in
  // some bridge opens as that bridge's tab kind so we attach instead of being
  // refused; otherwise the device's claudeBridge preference decides.
  function openResumedClaude(sessionId: string, title: string, live: 'cli' | 'sdk' | null | undefined) {
    const kind = live ?? localPrefs.claudeBridge;
    if (kind === 'cli') openSessionTab(sessionId, title);
    else openSdkTab(sessionId, title);
  }
  function liveBadge(live: 'cli' | 'sdk' | null | undefined): string | undefined {
    if (live === 'sdk') return '● live · SDK tab';
    if (live === 'cli') return '● live · classic tab';
    return undefined;
  }

  // Model: web.SessionPicker — resume list for the classic bridge.
  const resumeCliSessions = async () => {
    if (!activeProject) return;
    const list = await listResumableSessions(activeProject.id);
    if (list.length === 0) {
      alert('No resumable Claude sessions for this project');
      return;
    }
    const items: PickerItem[] = list.map((s) => ({
      id: s.uuid,
      primary: s.title || s.preview || s.uuid.slice(0, 8),
      secondary: s.uuid.slice(0, 8),
      timestamp: s.mtime,
      badge: liveBadge(s.live) ?? (s.wire ? `⚡ ${s.wire} wire` : undefined),
    }));
    setPicker({
      title: 'Resume Claude session',
      items,
      onPick: (uuid) => {
        const s = list.find((x) => x.uuid === uuid);
        if (s) openResumedClaude(s.uuid, s.title || s.preview.slice(0, 30) || s.uuid.slice(0, 8), s.live);
        setPicker(null);
      },
    });
  };

  // Model: web.SdkSessionPicker — resume list for the Agent SDK bridge.
  const resumeSdkSessions = async () => {
    if (!activeProject) return;
    const list = await listSdkSessions(activeProject.id);
    if (list.length === 0) {
      alert('No resumable Claude sessions for this project');
      return;
    }
    const items: PickerItem[] = list.map((s) => ({
      id: s.sessionId,
      primary: s.title || s.sessionId.slice(0, 8),
      secondary: s.sessionId.slice(0, 8),
      timestamp: s.lastModified,
      badge: liveBadge(s.liveIn),
    }));
    setPicker({
      title: 'Resume Claude session',
      items,
      onPick: (sid) => {
        const s = list.find((x) => x.sessionId === sid);
        if (s) openResumedClaude(s.sessionId, s.title || s.sessionId.slice(0, 8), s.liveIn);
        setPicker(null);
      },
    });
  };

  function openDevinTab(resumeId?: string, title?: string): string | undefined {
    if (!activeProjectId) {
      logDebug('tab', 'openDevinTab ignored — no active project');
      return;
    }
    if (resumeId) {
      const existing = tabs.find((t) => t.type === 'devin' && t.resumeId === resumeId);
      if (existing) {
        logDebug('tab', `openDevinTab: devin session ${resumeId} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return existing.id;
      }
    }
    const d = new Date();
    const defaultTitle = `Devin ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tab: Tab = { id: randomId(), type: 'devin', resumeId, title: title || defaultTitle };
    logDebug('tab', `openDevinTab: new devin tab ${tab.id}${resumeId ? ` (resume ${resumeId})` : ' (fresh)'} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
    return tab.id;
  }

  // Generic append + activate for registered tab kinds (TabRenderContext.openTab).
  function openTab(newTab: Tab) {
    if (!activeProjectId) {
      logDebug('tab', `openTab(${newTab.type}) ignored — no active project`);
      return;
    }
    // File tabs dedupe on path (same as the file tree) so a citation clicked
    // twice, or for a file already open, just activates the existing tab.
    if (newTab.type === 'file') {
      openFileTab(newTab.path);
      return;
    }
    // Editor tabs dedupe on path too, independently of file tabs (a file may
    // be open read-only and in the editor at once).
    // An existing session, asked for by a panel (a child session's card in
    // its parent's chat): the tab that already has it, or a new one.
    if (newTab.type === 'claude-sdk' && newTab.resumeId) {
      openSdkTab(newTab.resumeId, newTab.title);
      return;
    }
    if (newTab.type === 'editor') {
      const existing = tabs.find((t) => t.type === 'editor' && t.path === newTab.path);
      if (existing) {
        logDebug('tab', `openTab: editor for ${newTab.path} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return;
      }
    }
    // rule-071: panels ask for a `session` tab; the device's bridge
    // preference decides which Claude kind actually opens (initialPrompt /
    // wire carried over). Resumes keep their requested kind.
    const requested: Tab = newTab.type === 'session' && !newTab.resumeId && localPrefs.claudeBridge === 'sdk'
      ? { id: newTab.id, type: 'claude-sdk', title: newTab.title, initialPrompt: newTab.initialPrompt, wire: newTab.wire }
      : newTab;
    const tab: Tab = { ...requested };
    logDebug('tab', `openTab: new ${tab.type} tab ${tab.id} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
  }

  function openTabOfKind(kindId: string) {
    if (!activeProjectId || !activeProject) {
      logDebug('tab', `openTabOfKind(${kindId}) ignored — no active project`);
      return;
    }
    const kind = getTabKind(kindId);
    if (!kind?.createAction) {
      logDebug('tab', `openTabOfKind(${kindId}) ignored — kind not registered or missing createAction`);
      return;
    }
    if (kind.singleton) {
      const existing = tabs.find((t) => t.type === kindId);
      if (existing) {
        logDebug('tab', `openTabOfKind(${kindId}): singleton already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return;
      }
    }
    const created = kind.createAction.create({ project: { id: activeProject.id, path: activeProject.path } });
    const tab: Tab = { ...created };
    logDebug('tab', `openTabOfKind: new ${kindId} tab ${tab.id} in project ${activeProjectId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, tab.id);
  }

  // Model: web.ObserveTab. Open (or re-activate) the observation of a session
  // tab; one observe tab per source session per project.
  function observeTab(src: Tab) {
    if (!activeProjectId) return;
    if ((src.type !== 'session' && src.type !== 'claude-sdk' && src.type !== 'devin') || !src.resumeId) {
      logDebug('tab', `observeTab ignored — ${src.type} tab without resumeId`);
      return;
    }
    // A claude-sdk tab observes the same jsonl + wire directory as a classic
    // one, so its origin is recorded as `session` (rule-325): one observe
    // tab per Claude session whichever bridge drives it.
    const origin: TabRef = { type: src.type === 'claude-sdk' ? 'session' : src.type, key: src.resumeId };
    const existing = tabs.find((t) => t.type === 'observe' && sameTabRef(t.origin, origin));
    if (existing) {
      logDebug('tab', `observeTab: ${origin.type} ${origin.key} already observed (tab ${existing.id}), activating`);
      setActiveTab(activeProjectId, existing.id);
      return;
    }
    // The 👁 comes from tabIcon(); a glyph in the title would show twice.
    const title = src.title || src.resumeId.slice(0, 8);
    openTab({ id: randomId(), type: 'observe', origin, title });
  }

  // Model: web.NewChildSession — a fresh Claude (SDK) session filed under
  // `row` in the Sessions tree. A full session: its own process, prompt,
  // model. Always the SDK bridge: only it records the link.
  // `inWorktree`: the child gets its own git worktree and branch first
  // (model: Session.worktree), so its edits can't collide with the parent's.
  // 'compacted': the child starts as a compacted copy of the parent's whole
  // conversation instead of a summary of it.
  async function openChildSession(row: SessionRow, mode: 'plain' | 'worktree' | 'compacted' = 'plain') {
    const inWorktree = mode === 'worktree';
    if (!activeProjectId) return;
    if (row.projectId !== activeProjectId) {
      showAppToast('Switch to that session\'s project to open a child session');
      return;
    }
    const title = `Child of ${row.title}`.slice(0, 60);
    if (mode === 'compacted') {
      showAppToast('Compacting a copy of the parent session…');
      try {
        const child = await forkChildSession(activeProjectId, row.sessionId);
        openSdkTab(child.sessionId, child.title);
      } catch (e) {
        showAppToast(`Child session not created: ${(e as Error).message}`);
      }
      return;
    }
    if (!inWorktree) { openSdkTab(undefined, title, { parentSessionId: row.sessionId }); return; }
    try {
      const wt = await createWorktree(activeProjectId, title);
      openSdkTab(undefined, title, { parentSessionId: row.sessionId, worktree: wt.name });
      showAppToast(`Worktree ${wt.path} on branch ${wt.branch}`);
    } catch (e) {
      showAppToast(`Worktree not created: ${(e as Error).message}`);
    }
  }

  // Model: web.SessionList tree → web.SubagentPanel. Open (or re-activate)
  // the read-only view of one subagent; one tab per subagent per project.
  function openSubagentTab(row: SessionRow, s: SubagentInfo) {
    if (!activeProjectId) return;
    if (row.projectId !== activeProjectId) {
      showAppToast('Switch to that session\'s project to open its subagents');
      return;
    }
    const existing = tabs.find((t) => t.type === 'subagent' && t.sessionId === row.sessionId && t.agentId === s.agentId);
    if (existing) { setActiveTab(activeProjectId, existing.id); return; }
    openTab({ id: randomId(), type: 'subagent', sessionId: row.sessionId, agentId: s.agentId, title: s.description });
  }

  function activateTab(id: string) {
    if (!activeProjectId) return;
    setActiveTab(activeProjectId, id);
  }

  function closeTab(id: string) {
    if (!activeProjectId) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) {
      logDebug('tab', `closeTab(${id}) ignored — tab not found`);
      return;
    }
    const guard = closeGuardRef.current.get(id);
    if (guard && !guard()) {
      logDebug('tab', `closeTab(${id}) vetoed by the panel's close guard`);
      return;
    }
    closeGuardRef.current.delete(id);
    const nextTabs = tabs.filter((t) => t.id !== id);
    logDebug('tab', `closeTab: closed tab ${id} in project ${activeProjectId} (${tabs.length} → ${nextTabs.length})`);
    updateProjectTabs(activeProjectId, nextTabs);
    // Release the mounted-panel slot so it can be re-mounted fresh if the
    // user later opens a tab with the same id (unlikely but possible on
    // workspace reload).
    setVisitedTabs((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (activeTabId === id) {
      // Fall back to the neighbour that slides into the closed tab's place.
      const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null;
      logDebug('tab', `closed tab was active → fallback to ${fallback ?? 'null'}`);
      setActiveSelection(activeProjectId, fallback);
    }
  }

  // ---- Review (model: entity Batch / Comment; package Review) ----
  // All mutations go through lib/review on the freshest batches[] (not this
  // render's closure) so back-to-back changes compose.

  function latestBatches(): Batch[] {
    return activeProjectId ? workspaceRef.current.projects[activeProjectId]?.batches ?? [] : [];
  }

  function applyBatches(label: string, fn: (batches: Batch[]) => Batch[]) {
    if (!activeProjectId) return;
    const before = latestBatches();
    const next = fn(before);
    if (next === before) return;
    logDebug('review', label);
    updateProjectBatches(activeProjectId, next);
  }

  const currentBatch = review.resolveCurrentBatch(batches, activeProjectId ? currentBatches[activeProjectId] : null);

  function setCurrentBatch(batchId: string) {
    if (!activeProjectId) return;
    setCurrentBatches((m) => ({ ...m, [activeProjectId]: batchId }));
  }

  // The batch new comments go to, creating "Batch N" when no draft exists.
  function withCurrentBatch(batches: Batch[]): { batches: Batch[]; batch: Batch } {
    const existing = review.resolveCurrentBatch(batches, activeProjectId ? currentBatches[activeProjectId] : null);
    if (existing) return { batches, batch: existing };
    const batch = review.newBatch(batches, randomId(), Date.now());
    setCurrentBatch(batch.id);
    return { batches: [...batches, batch], batch };
  }

  function createBatch() {
    applyBatches('createBatch', (bs) => {
      const batch = review.newBatch(bs, randomId(), Date.now());
      setCurrentBatch(batch.id);
      return [...bs, batch];
    });
  }

  function renameBatch(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    applyBatches(`renameBatch: ${id}`, (bs) => (
      bs.some((b) => b.id === id && b.name !== trimmed) ? bs.map((b) => (b.id === id ? { ...b, name: trimmed } : b)) : bs
    ));
  }

  function deleteBatch(id: string) {
    const batch = latestBatches().find((b) => b.id === id);
    if (!batch) return;
    if (batch.status === 'draft' && batch.comments.length > 0) {
      const n = batch.comments.length;
      if (!confirm(`Delete "${batch.name}" and its ${n} comment${n === 1 ? '' : 's'}?`)) return;
    }
    applyBatches(`deleteBatch: ${id}`, (bs) => bs.filter((b) => b.id !== id));
  }

  // "+ Comment" under a batch in the panel (model: web.AddComment).
  function addPlainComment(batchId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const origin = tabRef(activeTab);
    const comment: Comment = { id: randomId(), text: trimmed, createdAt: Date.now(), ...(origin ? { tab: origin } : {}) };
    applyBatches(`addComment: ${comment.id} → batch ${batchId}`, (bs) => review.addComment(bs, batchId, comment));
  }

  // From a session panel: a text selection (model: web.CommentOnSelection).
  // Returns a status for the panel to toast.
  function addSessionComment(tab: Tab, c: NewComment): string | null {
    if (!activeProjectId) return null;
    const trimmed = c.text.trim();
    if (!trimmed) return null;
    const origin = tabRef(tab);
    const comment: Comment = {
      id: randomId(),
      text: trimmed,
      createdAt: Date.now(),
      ...(c.quote ? { quote: review.clampQuote(c.quote) } : {}),
      ...(origin ? { tab: origin } : {}),
      // An anchor is only meaningful together with the session it lives in.
      ...(origin && c.anchor ? { anchor: c.anchor } : {}),
    };
    const { batches: withBatch, batch } = withCurrentBatch(latestBatches());
    logDebug('review', `comment ${comment.id} → batch ${batch.id} (${comment.anchor ?? 'no anchor'}${comment.quote ? `, quote ${comment.quote.length} chars` : ''})`);
    updateProjectBatches(activeProjectId, review.addComment(withBatch, batch.id, comment));
    // A collapsed panel would hide the new row — open it so the user sees
    // where the comment went (model: web.ToggleReviewPanel).
    showReview();
    return `Added to ${batch.name}`;
  }

  function editComment(id: string, text: string) {
    applyBatches(`editComment: ${id}`, (bs) => review.editComment(bs, id, text));
  }

  function deleteComment(id: string) {
    applyBatches(`deleteComment: ${id}`, (bs) => review.deleteComment(bs, id));
  }

  // Reorder within a batch or move to another draft (model:
  // web.ReorderComments / web.MoveComment).
  function placeComment(id: string, batchId: string, index?: number) {
    applyBatches(`placeComment: ${id} → batch ${batchId}${index == null ? '' : ` @${index}`}`, (bs) => review.placeComment(bs, id, batchId, index));
  }

  function moveCommentToNewBatch(id: string) {
    applyBatches(`moveCommentToNewBatch: ${id}`, (bs) => {
      const batch = review.newBatch(bs, randomId(), Date.now());
      const next = review.placeComment([...bs, batch], id, batch.id);
      if (next.length === bs.length + 1 && next[next.length - 1].comments.length === 0) return bs;
      setCurrentBatch(batch.id);
      return next;
    });
  }

  // Model: web.ViewQuoteComments — a painted quote was clicked in a session:
  // make sure the panel is showing, then have it scroll to / flash the row.
  const [focusedComment, setFocusedComment] = useState<{ id: string; seq: number } | null>(null);
  function focusComment(commentId: string) {
    showReview();
    setDrawerOpen(false);
    setReviewDrawerOpen(true);
    setFocusedComment((prev) => ({ id: commentId, seq: (prev?.seq ?? 0) + 1 }));
  }

  function reopenBatch(id: string) {
    applyBatches(`reopenBatch: ${id}`, (bs) => review.reopenBatch(bs, id));
  }

  // Reported by a session panel once a prompt carrying this Batch really
  // went out (model: web.InsertBatchPrompt).
  function markBatchSent(batchId: string) {
    applyBatches(`markBatchSent: ${batchId}`, (bs) => review.markBatchSent(bs, batchId, Date.now()));
  }

  // ---- Bookmarks (model: entity Bookmark; web.BookmarkMessage / RemoveBookmark) ----

  function latestBookmarks(): Bookmark[] {
    return activeProjectId ? workspaceRef.current.projects[activeProjectId]?.bookmarks ?? [] : [];
  }

  // ☆ clicked on a message in a session panel: one Bookmark per (session,
  // anchor) — add it, or remove the existing one. Returns a toast for the panel.
  function toggleSessionBookmark(tab: Tab, b: NewBookmark): string | null {
    if (!activeProjectId) return null;
    const origin = tabRef(tab);
    if (!origin || !b.anchor) return null;
    const { bookmarks: next, added } = review.toggleBookmark(latestBookmarks(), {
      id: randomId(),
      label: b.label,
      tab: origin,
      anchor: b.anchor,
      createdAt: Date.now(),
    });
    logDebug('review', `${added ? 'bookmark' : 'unbookmark'} ${b.anchor} in ${origin.type} ${origin.key}`);
    updateProjectBookmarks(activeProjectId, next);
    // Same as a new comment: a collapsed panel would hide the new row.
    if (added) showReview();
    return added ? 'Bookmarked' : 'Bookmark removed';
  }

  function removeBookmark(id: string) {
    if (!activeProjectId) return;
    const before = latestBookmarks();
    const next = review.removeBookmark(before, id);
    if (next === before) return;
    logDebug('review', `removeBookmark: ${id}`);
    updateProjectBookmarks(activeProjectId, next);
  }

  // Bookmarked anchors per session tab (model: web.BookmarkMessage) so the
  // panels can render ★ on those messages.
  const bookmarkedAnchorsByTab = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const t of tabs) {
      if (t.type !== 'session' && t.type !== 'claude-sdk' && t.type !== 'devin') continue;
      const ref = tabRef(t);
      const set = ref ? review.bookmarkedAnchorsFor(bookmarks, ref) : null;
      if (set && set.size) map.set(t.id, set);
    }
    return map;
  }, [tabs, bookmarks]);

  // Anchored comments per tab (model: web.HighlightQuotes) so panels can
  // outline those messages and paint the quotes. Recomputed only when
  // batches / tabs change.
  const commentMarksByTab = useMemo(() => {
    const map = new Map<string, review.CommentMark[]>();
    for (const t of tabs) {
      if (t.type !== 'session' && t.type !== 'claude-sdk' && t.type !== 'devin') continue;
      const ref = tabRef(t);
      const marks = ref ? review.commentMarksFor(batches, ref) : [];
      if (marks.length) map.set(t.id, marks);
    }
    return map;
  }, [tabs, batches]);
  const draftComments = useMemo(() => review.draftCommentCount(batches), [batches]);

  // Activate the tab a TabRef points at, re-opening it if it was closed.
  // Returns the tab id (model: web.JumpToComment / web.SendBatch → OpenTab).
  function openTabRef(ref: TabRef, title: string): string | undefined {
    if (!activeProjectId) return undefined;
    const existing = tabs.find((t) => sameTabRef(tabRef(t), ref));
    if (existing) {
      setActiveTab(activeProjectId, existing.id);
      return existing.id;
    }
    // rule-405: a Claude session ref opens as whichever kind the device
    // prefers (both openers dedupe across kinds first).
    if (ref.type === 'session' || ref.type === 'claude-sdk') return localPrefs.claudeBridge === 'sdk' ? openSdkTab(ref.key, title) : openSessionTab(ref.key, title);
    if (ref.type === 'devin') return openDevinTab(ref.key, title);
    // Non-session tabs have no panel API to follow up with; no id needed.
    if (ref.type === 'file') openFileTab(ref.key);
    else openTabOfKind(ref.type);
    return undefined;
  }

  // Model: web.SessionAlerts — a clicked card: go to that session, in
  // whichever project it lives. Another project is switched to first; the
  // tab is opened once that project's tabs are the ones on screen.
  const pendingAlertOpenRef = useRef<{ projectId: string; ref: TabRef; title: string; live?: 'cli' | 'sdk' | null } | null>(null);
  // Go to a session in the project on screen: its tab if there is one, else
  // a new tab. A Claude session whose process is live in one bridge must open
  // as that bridge's tab kind (rule-378), hence `live`.
  function openSessionHere(ref: TabRef, title: string, live?: 'cli' | 'sdk' | null) {
    const existing = tabs.find((t) => sameTabRef(tabRef(t), ref));
    if (existing || ref.type === 'devin' || !live) { openTabRef(ref, title); return; }
    openResumedClaude(ref.key, title, live);
  }
  // Model: web.SessionList — a clicked row; like a clicked alert card, it may
  // live in another project.
  function openSessionRow(row: SessionRow) {
    setAlerts((prev) => prev.filter((a) => alertKey(a) !== sessionRowKey(row)));
    const ref: TabRef = { type: row.kind === 'devin' ? 'devin' : 'session', key: row.sessionId };
    const live = row.live === 'cli' || row.live === 'sdk' ? row.live : null;
    if (row.projectId !== activeProjectId) {
      pendingAlertOpenRef.current = { projectId: row.projectId, ref, title: row.title, live };
      setActiveProject(row.projectId);
      return;
    }
    openSessionHere(ref, row.title, live);
  }
  const showsSession = (t: Tab, row: SessionRow) =>
    isSessionTab(t) && t.resumeId === row.sessionId && (t.type === 'devin') === (row.kind === 'devin');
  // Renamed in the list: open tabs showing it follow, in whichever project.
  function retitleSessionTabs(row: SessionRow, title: string) {
    const pw = workspaceRef.current.projects[row.projectId];
    if (!pw?.tabs.some((t) => showsSession(t, row))) return;
    updateProjectTabs(row.projectId, pw.tabs.map((t) => (showsSession(t, row) ? { ...t, title } : t)));
  }
  // Deleted or archived in the list: its tabs go with it. (Archiving puts
  // a session away; a tab left open would keep it in front of the user.)
  function closeSessionTabs(row: SessionRow) {
    const pw = workspaceRef.current.projects[row.projectId];
    const gone = pw?.tabs.filter((t) => showsSession(t, row)) ?? [];
    if (gone.length === 0) return;
    if (row.projectId === activeProjectId) { for (const t of gone) closeTab(t.id); return; }
    updateProjectTabs(row.projectId, pw!.tabs.filter((t) => !showsSession(t, row)));
  }
  function openSessionAlert(e: SessionEvent) {
    setAlerts((prev) => prev.filter((a) => alertKey(a) !== alertKey(e)));
    if (!projects.some((p) => p.id === e.projectId)) {
      showAppToast('That project is no longer in the list');
      return;
    }
    const title = describeAlert(e).title;
    const ref: TabRef | null = e.sessionId ? { type: e.tabType === 'devin' ? 'devin' : 'session', key: e.sessionId } : null;
    if (e.projectId !== activeProjectId) {
      pendingAlertOpenRef.current = ref ? { projectId: e.projectId, ref, title } : null;
      setActiveProject(e.projectId);
      return;
    }
    if (ref) openTabRef(ref, title);
  }
  openSessionAlertRef.current = openSessionAlert;
  // Model: web.Inbox — a clicked row: mark it read and go to its session. On
  // a phone the column and the drawer close so the session is what you see.
  function openInboxItem(item: InboxItem) {
    markInboxRead([item.id]);
    if (window.matchMedia('(max-width: 768px)').matches) { setInboxOpen(false); setDrawerOpen(false); }
    openSessionAlert(item);
  }
  useEffect(() => {
    const p = pendingAlertOpenRef.current;
    if (!p || p.projectId !== activeProjectId) return;
    pendingAlertOpenRef.current = null;
    openSessionHere(p.ref, p.title, p.live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Model: web.RevealMessage via OpenTab — the one path behind JumpToComment,
  // JumpToBookmark and ObserveTab: bring back the tab `ref` points at (title
  // used if it has to be re-opened), then ask its panel to scroll to `anchor`.
  // Panel already mounted → reveal now (it waits internally until the tab is
  // actually displayed). Otherwise registerPanelApi fires it on mount.
  function revealAt(ref: TabRef, anchor: string, title: string, channel: string, what: string) {
    const tabId = openTabRef(ref, title);
    logDebug(channel, `${what} → tab ${tabId ?? '(none)'} anchor ${anchor}`);
    if (!tabId) return;
    pendingRevealRef.current = { tabId, anchor };
    fireReveal(tabId, anchor);
  }

  // Clicking a comment row: bring back the tab it was written in, then (if
  // it has an anchor) scroll to the message.
  function jumpToComment(comment: Comment) {
    if (!comment.tab) return;
    setReviewDrawerOpen(false);
    const title = comment.text.slice(0, 30);
    if (!comment.anchor) {
      openTabRef(comment.tab, title);
      logDebug('review', `jumpToComment: ${comment.id} (no anchor)`);
      return;
    }
    revealAt(comment.tab, comment.anchor, title, 'review', `jumpToComment: ${comment.id}`);
  }

  // Model: web.JumpToBookmark — a bookmark row in the Review panel.
  function jumpToBookmark(b: Bookmark) {
    setReviewDrawerOpen(false);
    revealAt(b.tab, b.anchor, b.label.slice(0, 30), 'review', `jumpToBookmark: ${b.id}`);
  }

  // Model: web.ObserveTab → web.RevealMessage, from an observation card.
  function revealInSession(origin: TabRef, anchor: string) {
    revealAt(origin, anchor, origin.key.slice(0, 8), 'observe', `reveal in ${origin.type} ${origin.key}`);
  }

  // Model: web.AddToChat from the file viewer — append the composed quote to
  // the input of the session the user was last in (else the newest session
  // tab), staying on the file so more passages can follow. A session that was
  // never shown since load has no panel yet: mount it hidden and let
  // registerPanelApi deliver, piling up quotes added in the meantime.
  function addQuoteToChat(quote: ChatQuote) {
    if (!activeProjectId) return;
    const lastId = lastSessionTabRef.current.get(activeProjectId);
    const target = tabs.find((t) => t.id === lastId && isSessionTab(t)) ?? [...tabs].reverse().find(isSessionTab);
    if (!target) {
      showAppToast('Open a chat session first — nowhere to add this');
      return;
    }
    const targetId = target.id;
    const api = panelApiRef.current.get(targetId);
    if (api) {
      logDebug('review', `add quote card to tab ${targetId} (${quote.quote.length} chars)`);
      api.addQuotes([quote]);
    } else {
      const pending = pendingQuotesRef.current;
      pendingQuotesRef.current = pending && pending.tabId === targetId
        ? { tabId: targetId, quotes: [...pending.quotes, quote] }
        : { tabId: targetId, quotes: [quote] };
      setVisitedTabs((prev) => (prev.has(targetId) ? prev : new Set(prev).add(targetId)));
    }
    showAppToast(`Added to chat: ${('title' in target && target.title) || tabTitle(target)}`);
  }

  // Model: web.SendBatch — fill the batch's prompt into the target session's
  // input box. The Batch only turns `sent` when the user really sends it.
  function sendBatch(id: string) {
    const batch = latestBatches().find((b) => b.id === id);
    if (!batch || batch.comments.length === 0 || !activeProjectId) return;
    const target = review.batchTargetSession(batch);
    let tabId: string | undefined;
    if (target) tabId = openTabRef(target, batch.name);
    else if (activeTab && isSessionTab(activeTab)) tabId = activeTab.id;
    if (!tabId) {
      showAppToast('Open the session tab you want to send this batch to');
      return;
    }
    setReviewDrawerOpen(false);
    const text = review.composeBatchPrompt(batch);
    logDebug('review', `sendBatch: ${id} (${batch.comments.length} comments) → tab ${tabId}`);
    pendingInsertRef.current = { tabId, text, batchId: id };
    fireInsert(tabId, text, id);
    showAppToast('Batch filled into the input — review and press Send');
  }

  async function handleAddProject(path: string, name?: string) {
    try {
      const p = await addProject({ path, name });
      logDebug('nav', `added project ${p.id} (${path})`);
      const ps = await listProjects();
      setProjects(ps);
      // In-memory only: server creates the workspace slot on the first
      // per-project PUT (when a tab is actually opened). No need to PUT an
      // empty slot up-front.
      setWorkspace((ws) => {
        if (ws.projects[p.id]) return ws;
        return { ...ws, projects: { ...ws.projects, [p.id]: { tabs: [], batches: [], bookmarks: [] } } };
      });
      setActive((a) => {
        logDebug('nav', `new project auto-active: ${a.projectId ?? 'null'} → ${p.id}`);
        return { ...a, projectId: p.id };
      });
    } catch (e: any) {
      logDebug('nav', `addProject failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  // Model: web.ArchiveProject — PATCH then re-list; reconcile (keyed on the
  // archived flag via projectIdsSig) moves the active pointer off an archived
  // project. Workspace data is untouched.
  async function handleArchiveProject(id: string, archived: boolean) {
    try {
      await updateProject(id, { archived });
      logDebug('nav', `${archived ? 'archived' : 'unarchived'} project ${id}`);
      setProjects(await listProjects());
    } catch (e: any) {
      logDebug('nav', `archiveProject failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  // Model: web.ReorderProjects — PUT the full order, then re-list.
  async function handleReorderProjects(ids: string[]) {
    try {
      await reorderProjects(ids);
      logDebug('nav', `reordered projects: ${ids.join(',')}`);
      setProjects(await listProjects());
    } catch (e: any) {
      logDebug('nav', `reorderProjects failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  async function handleDeleteProject(id: string) {
    if (!confirm('Remove this project from the list? (files are not touched)')) return;
    await deleteProject(id);
    logDebug('nav', `deleted project ${id}`);
    const ps = await listProjects();
    setProjects(ps);
    // Server-side deleteProject already removed the workspace slot for us
    // (see store.ts deleteProject). Just mirror in memory + drop any pending
    // per-project save timer for the deleted project.
    const pending = projectSaveTimers.current.get(id);
    if (pending) window.clearTimeout(pending);
    projectSaveTimers.current.delete(id);
    projectSavePayloads.current.delete(id);
    setWorkspace((ws) => {
      if (!ws.projects[id]) return ws;
      const nextProjects = { ...ws.projects };
      delete nextProjects[id];
      return { ...ws, projects: nextProjects };
    });
    setActive((a) => {
      const nextTabs = { ...a.tabs };
      delete nextTabs[id];
      const nextProject = a.projectId === id ? (ps[0]?.id ?? null) : a.projectId;
      if (a.projectId === id) {
        logDebug('nav', `deleted project was active → fallback to ${nextProject ?? 'null'}`);
      }
      return { projectId: nextProject, tabs: nextTabs };
    });
  }

  if (!authState) return <div className="loading">Loading…</div>;
  if (authState.required && !authState.authenticated) {
    return <Login onSuccess={() => window.location.reload()} />;
  }
  if (!loaded) return <div className="loading">Loading…</div>;

  // Model: web.ReviewPanel — the whole Review feature is opt-in (settings.review).
  const reviewOn = settings.review ?? false;

  // Model: web.CommandPalette — what Option+J / Option+K cycle through, and
  // the palette's actions.
  setActiveSelectionRef.current = setActiveSelection;
  tabCycleRef.current = { pid: activeProjectId, ids: tabs.map((t) => t.id), active: activeTabId };
  const paletteActions: PaletteAction[] = [
    ...(activeProject && localPrefs.enableClaude
      ? [{ id: 'new-claude', title: 'New Claude session', detail: `in ${activeProject.name}`, run: () => { if (localPrefs.claudeBridge === 'sdk') openSdkTab(); else openSessionTab(); } }]
      : []),
    ...(activeProject && localPrefs.enableDevin
      ? [{ id: 'new-devin', title: 'New Devin session', detail: `in ${activeProject.name}`, run: () => { openDevinTab(); } }]
      : []),
    { id: 'side-new', title: 'New side panel tab', detail: 'Changes, worktrees, Review · ⌥T', run: () => { setReviewCollapsed(false); setReviewDrawerOpen(true); askSide('launcher'); } },
    { id: 'side-toggle', title: reviewCollapsed ? 'Show the side panel' : 'Hide the side panel', run: () => setReviewCollapsed((v) => !v) },
    { id: 'settings', title: 'Open settings', run: () => setSettingsOpen(true) },
    { id: 'automations', title: 'Automations', detail: 'Schedules and webhooks that start sessions', run: () => setAutomationsOpen(true) },
  ];

  return (
    <div
      className={`app${sideMax && !reviewCollapsed ? ' side-maximized' : ''}`}
      style={{
        ...(sidebarWidth != null ? { '--sidebar-width': `${sidebarWidth}px` } : {}),
        ...(reviewCollapsed
          ? { '--review-width': `${REVIEW_COLLAPSED_WIDTH}px` }
          : reviewWidth != null ? { '--review-width': `${reviewWidth}px` } : {}),
      } as React.CSSProperties}
    >
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {reviewDrawerOpen && <div className="review-drawer-backdrop" onClick={() => setReviewDrawerOpen(false)} />}

      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="panel files-panel">
          <div
            className="sidebar-resize"
            title="Drag to resize; double-click to reset"
            onPointerDown={onSidebarResizeDown}
            onPointerMove={onSidebarResizeMove}
            onPointerUp={onSidebarResizeUp}
            onPointerCancel={onSidebarResizeUp}
            onDoubleClick={() => setSidebarWidth(null)}
          />
          <div className="panel-header">
            <ProjectPicker
              projects={projects.filter((p) => !p.archived)}
              activeId={activeProjectId}
              onSelect={setActiveProject}
              onManage={() => setProjectManagerOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenAutomations={() => setAutomationsOpen(true)}
              onOpenDevinUsage={() => setDevinUsageOpen(true)}
              onOpenDebug={() => setDebugOpen(true)}
            />
          </div>
          {activeProject && (
            <div className="sidebar-views" role="tablist" aria-label="Sidebar view">
              {([['files', 'Files'], ['sessions', 'Sessions']] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={sidebarView === v}
                  className={sidebarView === v ? 'on' : ''}
                  onClick={() => setSidebarView(v)}
                >
                  {label}
                  {v === 'sessions' && alerts.length > 0 && <span className="sidebar-views-badge">{alerts.length}</span>}
                </button>
              ))}
              <InboxButton unread={inbox.unread} open={inboxOpen} onToggle={() => setInboxOpen((o) => !o)} />
            </div>
          )}
          <div className="panel-body">
            {!activeProject ? (
              <div className="empty">Select or add a project</div>
            ) : sidebarView === 'sessions' ? (
              <SessionList
                projectId={activeProject.id}
                projectNames={projectNames}
                unread={unreadSessionKeys}
                activeKey={activeTab && isSessionTab(activeTab) && activeTab.resumeId
                  ? sessionRowKey({ projectId: activeProject.id, kind: activeTab.type === 'devin' ? 'devin' : 'claude', sessionId: activeTab.resumeId })
                  : null}
                refreshSignal={sessionListSignal}
                workspace={{
                  tabs,
                  activeTabId,
                  onActivateTab: (id) => { setDrawerOpen(false); activateTab(id); },
                }}
                activeSubagent={activeTab?.type === 'subagent' ? `${activeTab.sessionId}:${activeTab.agentId}` : null}
                onOpen={(row) => { setDrawerOpen(false); openSessionRow(row); }}
                onOpenSubagent={(row, s) => { setDrawerOpen(false); openSubagentTab(row, s); }}
                onNewChild={localPrefs.enableClaude ? (row, mode) => { setDrawerOpen(false); void openChildSession(row, mode); } : undefined}
                onNewClaude={localPrefs.enableClaude ? () => { setDrawerOpen(false); if (localPrefs.claudeBridge === 'sdk') openSdkTab(); else openSessionTab(); } : undefined}
                onNewDevin={localPrefs.enableDevin ? () => { setDrawerOpen(false); openDevinTab(); } : undefined}
                onRenamed={retitleSessionTabs}
                onDeleted={closeSessionTabs}
                onArchived={closeSessionTabs}
                onNotice={showAppToast}
              />
            ) : sidebarView === 'files' ? (
              <FileTree
                projectId={activeProject.id}
                projectName={activeProject.name}
                projectPath={activeProject.path}
                onSelect={(p) => {
                  openFileTab(p);
                  setDrawerOpen(false);
                }}
                onEdit={(p) => {
                  openTab({ id: randomId(), type: 'editor', path: p });
                  setDrawerOpen(false);
                }}
                selectedPath={activeTab?.type === 'file' ? activeTab.path : null}
                // Model: web.FileTree rule-413 — open file Tabs follow a
                // rename / move; Tab ids are stable so the Viewer just reloads.
                onEntryMoved={(from, to) => {
                  const pid = activeProject.id;
                  const live = workspaceRef.current.projects[pid]?.tabs ?? [];
                  let changed = false;
                  const next = live.map((t) => {
                    if (t.type !== 'file' && t.type !== 'editor') return t;
                    const np = rewriteMovedPath(t.path, from, to);
                    if (np === null) return t;
                    changed = true;
                    return { ...t, path: np };
                  });
                  if (changed) updateProjectTabs(pid, next);
                }}
                // Model: web.FileTree rule-459 — Tabs showing a deleted entry
                // close. Done against the live list (not closeTab, whose
                // `tabs` closure would go stale if several Tabs match).
                onEntryDeleted={(path) => {
                  const pid = activeProject.id;
                  const live = workspaceRef.current.projects[pid]?.tabs ?? [];
                  const gone = live.filter((t) => (t.type === 'file' || t.type === 'editor') && t.path === path);
                  if (gone.length === 0) return;
                  const goneIds = new Set(gone.map((t) => t.id));
                  for (const id of goneIds) closeGuardRef.current.delete(id);
                  const next = live.filter((t) => !goneIds.has(t.id));
                  updateProjectTabs(pid, next);
                  setVisitedTabs((prev) => {
                    const n = new Set(prev);
                    for (const id of goneIds) n.delete(id);
                    return n;
                  });
                  if (activeTabId && goneIds.has(activeTabId)) {
                    setActiveSelection(pid, next[0]?.id ?? null);
                  }
                }}
                onNotice={showAppToast}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="panel main-panel">
        <TabBar
          onMenuClick={() => { setReviewDrawerOpen(false); setDrawerOpen((v) => !v); }}
          reviewCount={draftComments}
          onReviewClick={() => { setDrawerOpen(false); setReviewDrawerOpen((v) => !v); }}
          onSearch={() => setPaletteOpen(true)}
          activeProjectName={activeProject?.name ?? null}
          onRefresh={
            activeTab
              ? () => setRefreshKey((r) => ({ ...r, [activeTab.id]: (r[activeTab.id] ?? 0) + 1 }))
              : undefined
          }
          onExport={activeExport?.open}
          canExport={activeExport?.canExport ?? false}
          tabs={tabs}
          activity={tabActivity}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          claudeBridge={localPrefs.claudeBridge}
          // Model: web entity Settings.enableClaude — provider entry points
          // only; everything else keeps working.
          onNewSession={localPrefs.enableClaude ? () => (localPrefs.claudeBridge === 'sdk' ? openSdkTab() : openSessionTab()) : undefined}
          onNewWireSession={localPrefs.enableClaude && localPrefs.showWireMenu ? () => (localPrefs.claudeBridge === 'sdk' ? openSdkTab(undefined, undefined, { wire: true }) : openSessionTab(undefined, undefined, { wire: true })) : undefined}
          onOpenTabKind={openTabOfKind}
          onObserve={observeTab}
          onResumeSession={activeProject && localPrefs.enableClaude ? (localPrefs.claudeBridge === 'sdk' ? resumeSdkSessions : resumeCliSessions) : undefined}
          onRenameSdkSession={(tab) => void renameSdkTab(tab)}
          onNewDevinSession={activeProject && localPrefs.enableDevin ? () => openDevinTab() : undefined}
          onResumeDevinSession={
            activeProject && localPrefs.enableDevin
              ? async () => {
                  const list = await listDevinSessions(activeProject.id);
                  if (list.length === 0) {
                    alert('No resumable Devin sessions for this project');
                    return;
                  }
                  const items: PickerItem[] = list.map((s) => ({
                    id: s.sessionId,
                    primary: s.title || s.sessionId,
                    secondary: s.sessionId,
                    timestamp: s.updatedAt ? new Date(s.updatedAt).getTime() : undefined,
                  }));
                  setPicker({
                    title: 'Resume Devin session',
                    items,
                    onPick: (sid) => {
                      const s = list.find((x) => x.sessionId === sid);
                      if (s) openDevinTab(s.sessionId, s.title || s.sessionId);
                      setPicker(null);
                    },
                  });
                }
              : undefined
          }
        />
        <div className="panel-body main-body">
          {activeProject ? (
            <>
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                // Lazy-mount gate: skip rendering until this tab has been the
                // active tab at least once. Prevents e.g. 77 devin panels
                // spinning up transcript fetches + WS connections at boot.
                if (!isActive && !visitedTabs.has(tab.id)) return null;
                const rk = refreshKey[tab.id] ?? 0;
                const tabKey = `${tab.id}-${rk}`;
                const style: React.CSSProperties = isActive
                  ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
                  : { display: 'none' };
                const kind = getTabKind(tab.type);
                const body = kind ? kind.render({
                  tab,
                  project: activeProject,
                  settings,
                  // Model: TabKindRegistry rule-367 — feed the updater the live
                  // tabs from workspaceRef, not this render's snapshot. Panels
                  // call this from WS handlers captured at mount (ChatPanel /
                  // DevinPanel [projectId] effects); with the snapshot, the
                  // init-time resumeId write clobbered the title set by the
                  // first prompt (and any tab opened since mount).
                  updateTabs: (updater) => {
                    const pid = activeProject.id;
                    const live = workspaceRef.current.projects[pid]?.tabs ?? [];
                    updateProjectTabs(pid, updater(live));
                  },
                  openTab,
                  updateSettings,
                  registerExportApi: (api) => registerExportApi(tab.id, api),
                  addComment: (c) => addSessionComment(tab, c),
                  addToChat: addQuoteToChat,
                  commentMarks: commentMarksByTab.get(tab.id) ?? NO_COMMENT_MARKS,
                  toggleBookmark: (b) => toggleSessionBookmark(tab, b),
                  bookmarkedAnchors: bookmarkedAnchorsByTab.get(tab.id) ?? NO_BOOKMARKED_ANCHORS,
                  markBatchSent,
                  focusComment,
                  registerPanelApi: (api) => registerPanelApi(tab.id, api),
                  registerCloseGuard: (guard) => registerCloseGuard(tab.id, guard),
                  revealInSession,
                  reportActivity: (a) => reportActivity(tab.id, a),
                }) : <div className="empty">Unknown tab kind: {tab.type}</div>;
                return <div key={tabKey} style={style}>{body}</div>;
              })}
              {!activeTab && (
                <div className="empty">
                  Open a file or start an AI session
                </div>
              )}
            </>
          ) : (
            <div className="empty">No project selected</div>
          )}
        </div>
      </div>

      {/* Model: web.SidePanel — tabs (Changes, Review, …), Maximize, Collapse. */}
      <div className={`review-drawer ${reviewDrawerOpen ? 'open' : ''}`}>
        <div className={`panel review-panel side-panel ${reviewCollapsed ? 'collapsed' : ''}`}>
          <div
            className="review-resize"
            title="Drag to resize; double-click to reset"
            onPointerDown={onReviewResizeDown}
            onPointerMove={onReviewResizeMove}
            onPointerUp={onReviewResizeUp}
            onPointerCancel={onReviewResizeUp}
            onDoubleClick={() => setReviewWidth(null)}
          />
          {activeProject ? (
            <SidePanel
              lsPrefix={LS_PREFIX}
              projectId={activeProject.id}
              projectName={activeProject.name}
              reviewOn={reviewOn}
              reviewCount={draftComments}
              follow={follow}
              onAddToChat={addQuoteToChat}
              collapsed={reviewCollapsed}
              maximized={sideMax}
              onToggleCollapse={() => setReviewCollapsed((v) => !v)}
              onToggleMax={() => setSideMax((v) => !v)}
              onCloseDrawer={() => setReviewDrawerOpen(false)}
              request={sideRequest}
              renderReview={() => (
                  <ReviewPanel
                    batches={batches}
                    bookmarks={bookmarks}
                    onJumpBookmark={jumpToBookmark}
                    onDeleteBookmark={removeBookmark}
                    currentBatchId={currentBatch?.id ?? null}
                    focused={focusedComment}
                    onAddComment={addPlainComment}
                    onEditComment={editComment}
                    onDeleteComment={deleteComment}
                    onPlaceComment={placeComment}
                    onMoveToNewBatch={moveCommentToNewBatch}
                    onJump={jumpToComment}
                    onCreateBatch={createBatch}
                    onRenameBatch={renameBatch}
                    onDeleteBatch={deleteBatch}
                    onSetCurrent={setCurrentBatch}
                    onSendBatch={sendBatch}
                    onReopenBatch={reopenBatch}
                  />
              )}
            />
          ) : (
            <div className="panel-body"><div className="empty">Select a project</div></div>
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          projects={projects}
          actions={paletteActions}
          onOpenSession={(row) => { setDrawerOpen(false); openSessionRow(row); }}
          onOpenProject={(id) => { setDrawerOpen(false); setActiveProject(id); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {inboxOpen && (
        <InboxPanel
          rows={inbox.items.map((item) => { const d = describeAlert(item); return { item, title: d.title, project: d.project }; })}
          unread={inbox.unread}
          hasMore={inbox.hasMore}
          loading={inboxLoading}
          onOpen={openInboxItem}
          onMarkRead={(item) => markInboxRead([item.id])}
          onMarkAllRead={() => markInboxRead('all')}
          onRemove={removeInboxItem}
          onClearAll={clearInbox}
          onLoadMore={() => void loadOlderInbox()}
          onClose={closeInbox}
        />
      )}
      {appToast && <div className="app-toast">{appToast}</div>}
      {/* Hidden under the open phone drawer: the cards would cover the
          Sessions list, which shows the same states itself. */}
      <SessionAlerts
        alerts={drawerOpen ? [] : alerts.map(describeAlert)}
        onOpen={openSessionAlert}
        onDismiss={(e) => { setAlerts((prev) => prev.filter((a) => a.id !== e.id)); markInboxSessionsRead([e]); }}
        onClear={() => { markInboxSessionsRead(alerts); setAlerts([]); }}
      />

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          local={localPrefs}
          onLocalChange={setLocalPrefs}
          username={authState?.username}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onSignOut={async () => {
            await logout();
            window.location.reload();
          }}
        />
      )}
      {automationsOpen && (
        <AutomationsDialog
          projects={projects}
          activeProjectId={activeProjectId}
          onOpenSession={(projectId, sessionId) => {
            setDrawerOpen(false);
            openSessionRow({ kind: 'claude', sessionId, projectId, title: '', updatedAt: Date.now(), live: null, state: null, archived: false });
          }}
          onClose={() => setAutomationsOpen(false)}
        />
      )}
      {devinUsageOpen && <DevinUsage onClose={() => setDevinUsageOpen(false)} />}
      {projectManagerOpen && (
        <ProjectManager
          projects={projects}
          activeId={activeProjectId}
          onAdd={handleAddProject}
          onArchive={handleArchiveProject}
          onReorder={handleReorderProjects}
          onDelete={handleDeleteProject}
          onClose={() => setProjectManagerOpen(false)}
        />
      )}
      {debugOpen && <DebugPanel onClose={() => setDebugOpen(false)} />}
      {picker && (
        <SessionPicker
          title={picker.title}
          items={picker.items}
          onPick={picker.onPick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

