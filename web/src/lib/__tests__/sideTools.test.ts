import { describe, expect, it } from 'vitest';
import { sideTranscript } from '../../components/SideChat';
import { openTab, parseSideState, type SideState } from '../sidePanel';

describe('side panel session tools', () => {
  const s: SideState = { tabs: [{ id: 'a', kind: 'changes', target: '@follow' }], active: 'a' };
  it('one tab of each, kept across a reload', () => {
    let st = s;
    for (const kind of ['progress', 'agents', 'observe', 'files', 'artifacts'] as const) st = openTab(st, { kind }, () => kind);
    expect(openTab(st, { kind: 'agents' }, () => 'x').tabs.length).toBe(6);
    expect(parseSideState(JSON.stringify(st), false).tabs.map((t) => t.kind)).toEqual(['changes', 'progress', 'agents', 'observe', 'files', 'artifacts']);
  });
  it('writes a side chat out for the child session it continues in', () => {
    expect(sideTranscript([{ role: 'user', text: 'Why X?' }, { role: 'tool', text: 'Read a.ts' }, { role: 'assistant', text: 'Because Y.' }, { role: 'note', text: 'Thinking…' }]))
      .toBe('Me: Why X?\n\nClaude: Because Y.');
  });
});

describe('side panel Terminal tabs', () => {
  const base: SideState = { tabs: [{ id: 'a', kind: 'changes', target: '@follow' }], active: 'a' };
  it('one shell per tab, shown only while the Terminal is on, kept across a reload', async () => {
    const { visibleTabs, activeTab } = await import('../sidePanel');
    let st = openTab(base, { kind: 'terminal', term: 't1' }, () => 'x1');
    st = openTab(st, { kind: 'terminal', term: 't2' }, () => 'x2');
    expect(st.tabs.map((t) => t.id)).toEqual(['a', 'x1', 'x2']);
    expect(openTab(st, { kind: 'terminal', term: 't1' }).active).toBe('x1');
    expect(visibleTabs(st, false).map((t) => t.id)).toEqual(['a']);
    expect(activeTab(st, false)?.id).toBe('a');
    expect(visibleTabs(st, false, true).map((t) => t.id)).toEqual(['a', 'x1', 'x2']);
    expect(parseSideState(JSON.stringify(st), false).tabs.map((t) => t.id)).toEqual(['a', 'x1', 'x2']);
    const bad = { tabs: [{ id: 'b', kind: 'terminal', term: '../x' }], active: 'b' };
    expect(parseSideState(JSON.stringify(bad), false).tabs.some((t) => t.kind === 'terminal')).toBe(false);
  });
});
