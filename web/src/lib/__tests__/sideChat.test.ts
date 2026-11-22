import { describe, expect, it } from 'vitest';
import { btwQuestion } from '../commandPicker';
import { openTab, parseSideState, type SideState } from '../sidePanel';

describe('/btw', () => {
  it('reads the question of a /btw message', () => {
    expect(btwQuestion('/btw why did you pick X?')).toBe('why did you pick X?');
    expect(btwQuestion('  /btw\nmulti\nline ')).toBe('multi\nline');
    expect(btwQuestion('/btw')).toBe('');
    expect(btwQuestion('/btwx')).toBeNull();
    expect(btwQuestion('tell me /btw')).toBeNull();
  });
  it('one side chat per session, kept across a reload', () => {
    const s: SideState = { tabs: [{ id: 'a', kind: 'changes', target: '@follow' }], active: 'a' };
    const one = openTab(s, { kind: 'btw', sessionId: 's1', label: 'Fix login' }, () => 'b');
    const again = openTab({ ...one, active: 'a' }, { kind: 'btw', sessionId: 's1', label: 'Fix login' }, () => 'c');
    expect([again.tabs.length, again.active]).toEqual([2, 'b']);
    expect(openTab(one, { kind: 'btw', sessionId: 's2', label: 'Other' }, () => 'd').tabs.length).toBe(3);
    expect(parseSideState(JSON.stringify(one), false).tabs.map((t) => t.kind)).toEqual(['changes', 'btw']);
  });
});
