import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatQuote } from '../lib/addToChat';
import {
  FOLLOW, ROOT, activate, activeTab, addLauncher, closeTab, openTab, parseSideState, pick, updateTab, visibleTabs,
  type SideState, type SideTab, type SideWant,
} from '../lib/sidePanel';
import { ChangesView, type FollowInfo } from './ChangesView';
import { SideLauncher } from './SideLauncher';
import { SideChat } from './SideChat';
import type { Theme } from '../types';
import { PreviewView } from './PreviewView';
import { AgentsView, ArtifactsView, FilesView, ProgressView } from './SideSessionViews';
import { ObservePanel } from './ObservePanel';
import type { SubagentInfo } from '../api';
import type { SessionRow } from '../lib/sessionList';

// Model: web.SidePanel — the right-hand column (formerly only Review): its
// own strip of tabs with "+", and on the right Maximize (take over the chat
// area) and Collapse. Desktop: third grid column, resizable from its left
// edge. Mobile: right-side drawer. One set of tabs per project, on this device.

// Asks the panel to show a tab: Review (a comment was just added) or a new
// launcher (Option+T). `seq` makes repeated asks distinct.
export type SideRequest =
  | { kind: 'review' | 'launcher'; seq: number }
  // Model: SideChat — open (or focus) the side chat about a session and ask.
  | { kind: 'btw'; sessionId: string; label: string; question: string; seq: number }
  // A session tool tab (the Plan strip's "open in side panel").
  | { kind: 'tool'; want: { kind: 'progress' | 'artifacts' }; seq: number };

export function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M10 2.5v11" />
    </svg>
  );
}
function MaximizeIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4.5-4.5M6.5 9.5L2 14" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M10 2h4v4M6 14H2v-4M14 2L9 7M2 14l5-5" />
    </svg>
  );
}

function tabTitle(t: SideTab, projectName: string, reviewCount: number): string {
  if (t.kind === 'review') return reviewCount ? `Review (${reviewCount})` : 'Review';
  if (t.kind === 'launcher') return 'New tab';
  if (t.kind === 'btw') return `btw · ${t.label}`;
  if (t.kind === 'preview') return `Preview :${t.port}`;
  if (t.kind === 'progress') return 'Progress';
  if (t.kind === 'agents') return 'Agents';
  if (t.kind === 'observe') return 'Observe';
  if (t.kind === 'artifacts') return 'Artifacts';
  if (t.kind === 'files') return 'Files';
  if (t.target === FOLLOW) return 'Changes';
  return `Changes · ${t.target === ROOT ? projectName : t.target}`;
}

function storageKey(prefix: string, projectId: string) { return `${prefix}side:${projectId}`; }

export function SidePanel({
  lsPrefix, projectId, projectName, projectPath, theme, reviewOn, reviewCount, renderReview, follow, onAddToChat,
  onOpenSession, onOpenSubagent, onReveal, onContinueAsChild,
  collapsed, maximized, onToggleCollapse, onToggleMax, onCloseDrawer, request,
}: {
  lsPrefix: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  theme: Theme;
  // Agents tab: open a child session / a subagent in the main area.
  onOpenSession: (row: SessionRow) => void;
  onOpenSubagent: (row: SessionRow, s: SubagentInfo) => void;
  // Observe tab: show this message of the session in its chat.
  onReveal: (sessionId: string, anchor: string) => void;
  // Side chat: carry on in a child session of `sessionId`, told what was said.
  onContinueAsChild: (sessionId: string, label: string, conversation: string) => void;
  reviewOn: boolean;
  reviewCount: number;
  renderReview: () => ReactNode;
  follow: FollowInfo | null;
  onAddToChat?: (quote: ChatQuote) => void;
  collapsed: boolean;
  maximized: boolean;
  onToggleCollapse: () => void;
  onToggleMax: () => void;
  // Mobile drawer's ×.
  onCloseDrawer: () => void;
  request: SideRequest | null;
}) {
  const load = (pid: string) => parseSideState(localStorage.getItem(storageKey(lsPrefix, pid)), reviewOn);
  const [state, setState] = useState<SideState>(() => load(projectId));
  const loadedFor = useRef(projectId);
  useEffect(() => {
    if (loadedFor.current === projectId) return;
    loadedFor.current = projectId;
    setState(load(projectId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    if (loadedFor.current !== projectId) return;
    try { localStorage.setItem(storageKey(lsPrefix, projectId), JSON.stringify(state)); } catch {}
  }, [state, projectId, lsPrefix]);

  // The latest /btw question, for the side chat about that session.
  const [btwAsk, setBtwAsk] = useState<{ sessionId: string; question: string; seq: number } | null>(null);
  const lastSeq = useRef(request?.seq ?? 0);
  useEffect(() => {
    if (!request || request.seq === lastSeq.current) return;
    lastSeq.current = request.seq;
    if (request.kind === 'review' && reviewOn) setState((s) => openTab(s, { kind: 'review' }));
    else if (request.kind === 'launcher') setState((s) => addLauncher(s));
    else if (request.kind === 'tool') setState((s) => openTab(s, request.want));
    else if (request.kind === 'btw') {
      setState((s) => openTab(s, { kind: 'btw', sessionId: request.sessionId, label: request.label }));
      if (request.question.trim()) setBtwAsk({ sessionId: request.sessionId, question: request.question, seq: request.seq });
    }
  }, [request, reviewOn]);

  const tabs = visibleTabs(state, reviewOn);
  const current = activeTab(state, reviewOn);
  // Keep the active tab in view when the strip scrolls sideways.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current?.querySelector('.side-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current?.id, collapsed]);

  let body: ReactNode;
  if (!current) {
    body = <SideLauncher projectId={projectId} projectName={projectName} reviewOn={reviewOn} followLabel={follow?.label ?? null} followSessionId={follow?.sessionId ?? null} onPick={(want) => setState((s) => openTab(s, want))} />;
  } else if (current.kind === 'launcher') {
    body = <SideLauncher key={current.id} projectId={projectId} projectName={projectName} reviewOn={reviewOn} followLabel={follow?.label ?? null} followSessionId={follow?.sessionId ?? null} onPick={(want) => setState((s) => pick(s, current.id, want))} />;
  } else if (current.kind === 'review') {
    body = renderReview();
  } else if (current.kind === 'btw') {
    body = null; // kept mounted below, so a side chat survives switching tabs
  } else if (current.kind === 'progress') {
    body = <ProgressView projectId={projectId} follow={follow} active={!collapsed} />;
  } else if (current.kind === 'agents') {
    body = <AgentsView projectId={projectId} follow={follow} active={!collapsed} onOpenSession={onOpenSession} onOpenSubagent={onOpenSubagent} />;
  } else if (current.kind === 'artifacts') {
    body = <ArtifactsView projectId={projectId} follow={follow} active={!collapsed} theme={theme} onAddToChat={onAddToChat} />;
  } else if (current.kind === 'files') {
    body = <FilesView projectId={projectId} projectName={projectName} projectPath={projectPath} theme={theme} onAddToChat={onAddToChat} />;
  } else if (current.kind === 'observe') {
    const sid = follow?.sessionId;
    body = sid
      ? <ObservePanel key={sid} projectId={projectId} origin={{ type: 'session', key: sid }} onReveal={(anchor) => onReveal(sid, anchor)} />
      : <div className="side-empty">Open a Claude session to observe it here: its turns, tool calls and tokens. This tab follows the session you are in.</div>;
  } else if (current.kind === 'preview') {
    const id = current.id;
    body = <PreviewView key={id} port={current.port} path={current.path} onPath={(path) => setState((s) => updateTab(s, id, { path }))} />;
  } else {
    body = <ChangesView key={current.id} projectId={projectId} projectName={projectName} target={current.target} follow={follow} active={!collapsed} onAddToChat={onAddToChat} />;
  }

  return (
    <>
      <div className="panel-header side-head">
        {!collapsed && (
          <div className="side-tabs" role="tablist" aria-label="Side panel tabs" ref={stripRef}>
            {tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === current?.id}
                className={`side-tab${t.id === current?.id ? ' active' : ''}`}
                onClick={() => setState((s) => activate(s, t.id))}
                title={tabTitle(t, projectName, reviewCount)}
              >
                <span className="side-tab-label">{tabTitle(t, projectName, reviewCount)}</span>
                <button
                  type="button"
                  className="side-tab-close"
                  aria-label="Close tab"
                  onClick={(e) => { e.stopPropagation(); setState((s) => closeTab(s, t.id)); }}
                >×</button>
              </div>
            ))}
          </div>
        )}
        {/* Outside the scrolling strip, so it stays in reach however many tabs there are. */}
        {!collapsed && <button type="button" className="side-add" onClick={() => setState((s) => addLauncher(s))} title="New tab (⌥T)" aria-label="New tab">+</button>}
        <div className="side-actions">
          {!collapsed && (
            <button type="button" className="side-icon side-max" onClick={onToggleMax} title={maximized ? 'Restore (show the chat again)' : 'Maximize over the chat area'} aria-label={maximized ? 'Restore' : 'Maximize'}>
              <MaximizeIcon on={maximized} />
            </button>
          )}
          <button
            type="button"
            className={`side-icon review-collapse${collapsed ? '' : ' on'}`}
            onClick={onToggleCollapse}
            title={collapsed ? 'Show the side panel' : 'Hide the side panel'}
            aria-label={collapsed ? 'Show the side panel' : 'Hide the side panel'}
          ><PanelIcon /></button>
          <button type="button" className="review-panel-close" onClick={onCloseDrawer} aria-label="Close">×</button>
        </div>
      </div>
      <div className="panel-body side-body">
        {body}
        {state.tabs.filter((t): t is Extract<SideTab, { kind: 'btw' }> => t.kind === 'btw').map((t) => (
          <div key={t.id} className="side-keep" style={t.id === current?.id ? undefined : { display: 'none' }}>
            <SideChat
              projectId={projectId}
              sessionId={t.sessionId}
              label={t.label}
              theme={theme}
              ask={btwAsk && btwAsk.sessionId === t.sessionId ? { question: btwAsk.question, seq: btwAsk.seq } : null}
              onContinue={(conversation) => onContinueAsChild(t.sessionId, t.label, conversation)}
            />
          </div>
        ))}
      </div>
    </>
  );
}
