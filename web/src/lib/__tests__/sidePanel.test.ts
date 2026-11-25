import { describe, expect, it } from 'vitest';
import { FOLLOW, ROOT, activate, activeTab, addLauncher, closeTab, defaultSideState, openTab, parseSideState, ownWant, pick, remember, showPage, tabOwner, visibleTabs, type SideState } from '../sidePanel';

const ids = () => { let n = 0; return () => `t${++n}`; };

describe('side panel tabs', () => {
  it('starts with Changes following the session, plus Review when it is on', () => {
    expect(defaultSideState(false, ids())).toEqual({ tabs: [{ id: 't1', kind: 'changes', target: FOLLOW }], active: 't1' });
    expect(defaultSideState(true, ids()).tabs.map((t) => t.kind)).toEqual(['changes', 'review']);
  });

  it('hides Review tabs while Review is off', () => {
    const s = { ...defaultSideState(true, ids()), active: 't2' };
    expect(visibleTabs(s, false).map((t) => t.id)).toEqual(['t1']);
    expect(activeTab(s, false)?.id).toBe('t1');
    expect(activeTab(s, true)?.id).toBe('t2');
  });

  it('openTab focuses an existing tab or adds one after the active tab', () => {
    const next = ids();
    let s = defaultSideState(true, next);
    s = openTab(s, { kind: 'review' }, next);
    expect(s.active).toBe('t2');
    s = activate(s, 't1');
    s = openTab(s, { kind: 'changes', target: 'wt-a' }, next);
    expect(s.tabs.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    expect(s.active).toBe('t3');
    expect(openTab(s, { kind: 'changes', target: 'wt-a' }, next).tabs).toHaveLength(3);
  });

  it('a launcher becomes the tool picked from it, or yields to an open one', () => {
    const next = ids();
    let s = addLauncher(defaultSideState(false, next), next);
    expect(s.active).toBe('t2');
    const picked = pick(s, 't2', { kind: 'changes', target: ROOT });
    expect(picked.tabs[1]).toEqual({ id: 't2', kind: 'changes', target: ROOT });
    const dup = pick(s, 't2', { kind: 'changes', target: FOLLOW });
    expect(dup).toEqual({ tabs: [{ id: 't1', kind: 'changes', target: FOLLOW }], active: 't1' });
  });

  it('closing the active tab activates its right neighbour, else the left', () => {
    const next = ids();
    let s = addLauncher(addLauncher(defaultSideState(false, next), next), next);
    s = activate(s, 't2');
    expect(closeTab(s, 't2').active).toBe('t3');
    expect(closeTab(s, 't3').active).toBe('t2');
    expect(closeTab(closeTab(closeTab(s, 't1'), 't2'), 't3')).toEqual({ tabs: [], active: null });
  });

  it('reads stored state and drops what it does not know', () => {
    const raw = JSON.stringify({ tabs: [{ id: 'a', kind: 'changes', target: 'x' }, { id: 'b', kind: 'weird' }, { id: 'c', kind: 'review' }], active: 'c' });
    expect(parseSideState(raw, true)).toEqual({ tabs: [{ id: 'a', kind: 'changes', target: 'x' }, { id: 'c', kind: 'review' }], active: 'c' });
    expect(parseSideState('nope', false).tabs.map((t) => t.kind)).toEqual(['changes']);
  });
});

describe('tabs that belong to a session', () => {
  // Changes (shared) + A's preview + a side chat about B.
  const base = (): SideState => ({
    tabs: [
      { id: 'c', kind: 'changes', target: FOLLOW },
      { id: 'pa', kind: 'preview', port: 5000, path: '/', owner: 'A' },
      { id: 'bb', kind: 'btw', sessionId: 'B', label: 'B' },
      { id: 'pu', kind: 'preview', port: 6000, path: '/' },
    ],
    active: 'pa',
  });
  it("show only in their session; shared ones everywhere", () => {
    expect(visibleTabs(base(), false, false, 'A').map((t) => t.id)).toEqual(['c', 'pa', 'pu']);
    expect(visibleTabs(base(), false, false, 'B').map((t) => t.id)).toEqual(['c', 'bb', 'pu']);
    expect(visibleTabs(base(), false, false, null).map((t) => t.id)).toEqual(['c', 'pu']);
    expect(tabOwner(base().tabs[1])).toBe('A');
  });
  it("another session's tab in front falls back to a shared one", () => {
    expect(activeTab(base(), false, false, 'A')?.id).toBe('pa');
    expect(activeTab(base(), false, false, 'B')?.id).toBe('c');
  });
  it('each session comes back to the tab it had in front', () => {
    let s = remember(base(), 'A');
    s = remember(activate(s, 'bb'), 'B');
    expect(s.activeBy).toEqual({ A: 'pa', B: 'bb' });
    expect(activeTab(s, false, false, 'A')?.id).toBe('pa');
    expect(activeTab(s, false, false, 'B')?.id).toBe('bb');
    // A session never remembers a tab it cannot see.
    expect(remember(activate(s, 'bb'), 'A').activeBy?.A).toBe('pa');
  });
  it('the same port shown by two sessions is two tabs', () => {
    const s = openTab(base(), { kind: 'preview', port: 5000, path: '/', owner: 'B' }, () => 'pb');
    expect(s.tabs.map((t) => t.id)).toContain('pb');
    expect(openTab(s, { kind: 'preview', port: 5000, path: '/x', owner: 'A' }).active).toBe('pa');
  });
  it('keeps owner and activeBy across a reload, dropping stale entries', () => {
    const raw = JSON.stringify({ ...base(), activeBy: { A: 'pa', B: 'gone' } });
    const s = parseSideState(raw, false);
    expect(s.tabs[1]).toEqual({ id: 'pa', kind: 'preview', port: 5000, path: '/', owner: 'A' });
    expect(s.activeBy).toEqual({ A: 'pa' });
  });
  it('a preview opened from "+" belongs to the session in front', () => {
    expect(ownWant({ kind: 'preview', port: 7000, path: '/' }, 'B')).toEqual({ kind: 'preview', port: 7000, path: '/', owner: 'B' });
    expect(ownWant({ kind: 'preview', port: 7000, path: '/' }, null)).toEqual({ kind: 'preview', port: 7000, path: '/' });
    expect(ownWant({ kind: 'files' }, 'B')).toEqual({ kind: 'files' });
  });
  it('closing a tab keeps what the sessions remembered', () => {
    const s = closeTab(remember(base(), 'A'), 'pu');
    expect(s.activeBy).toEqual({ A: 'pa' });
  });
});

describe('showPage (show_preview, live or replayed)', () => {
  let n = 0;
  const id = () => `t${n++}`;
  const base = (): SideState => ({ tabs: [{ id: 'c', kind: 'changes', target: FOLLOW }], active: 'c' });

  it('opens the page once per showing; a replay of the same showing is ignored', () => {
    const a = showPage(base(), { port: 5001, path: '/', owner: 's1' }, 100, id)!;
    const tab = a.tabs.find((t) => t.kind === 'preview')!;
    expect(tab).toMatchObject({ port: 5001, owner: 's1', byClaude: true });
    expect(a.active).toBe(tab.id);
    expect(a.shownBy).toEqual({ s1: 100 });
    expect(showPage(a, { port: 5001, path: '/', owner: 's1' }, 100, id)).toBeNull();
  });

  it("replaces the session's previous Claude page instead of adding a tab", () => {
    const a = showPage(base(), { port: 5001, path: '/', owner: 's1' }, 100, id)!;
    const b = showPage(a, { port: 5002, path: '/x', owner: 's1' }, 200, id)!;
    const previews = b.tabs.filter((t) => t.kind === 'preview');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ port: 5002, path: '/x' });
    expect(b.active).toBe(previews[0].id);
  });

  it("leaves pages the user opened and other sessions' pages alone", () => {
    const s: SideState = { tabs: [{ id: 'u', kind: 'preview', port: 3000, path: '/', owner: 's1' }, { id: 'o', kind: 'preview', port: 5001, path: '/', owner: 's2', byClaude: true }], active: 'u' };
    const b = showPage(s, { port: 5002, path: '/', owner: 's1' }, 1, id)!;
    expect(b.tabs.map((t) => t.kind === 'preview' && t.port)).toEqual([3000, 5002, 5001]);
  });

  it('focuses a tab already on that port, at the new path', () => {
    const s: SideState = { tabs: [{ id: 'u', kind: 'preview', port: 3000, path: '/', owner: 's1' }], active: null };
    const b = showPage(s, { port: 3000, path: '/a', owner: 's1' }, 1, id)!;
    expect(b.tabs).toHaveLength(1);
    expect(b).toMatchObject({ active: 'u', tabs: [{ path: '/a' }] });
  });

  it('keeps shownBy across a reload', () => {
    const a = showPage(base(), { port: 5001, path: '/', owner: 's1' }, 100, id)!;
    expect(parseSideState(JSON.stringify(a), false).shownBy).toEqual({ s1: 100 });
  });
});
