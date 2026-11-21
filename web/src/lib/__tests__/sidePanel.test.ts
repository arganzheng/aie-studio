import { describe, expect, it } from 'vitest';
import { FOLLOW, ROOT, activate, activeTab, addLauncher, closeTab, defaultSideState, openTab, parseSideState, pick, visibleTabs } from '../sidePanel';

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
