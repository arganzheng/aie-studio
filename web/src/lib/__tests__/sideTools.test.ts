import { describe, expect, it } from 'vitest';
import { sideTranscript } from '../../components/SideChat';
import { openTab, parseSideState, type SideState } from '../sidePanel';

describe('side panel session tools', () => {
  const s: SideState = { tabs: [{ id: 'a', kind: 'changes', target: '@follow' }], active: 'a' };
  it('one tab of each, kept across a reload', () => {
    let st = s;
    for (const kind of ['progress', 'agents', 'observe', 'files'] as const) st = openTab(st, { kind }, () => kind);
    expect(openTab(st, { kind: 'agents' }, () => 'x').tabs.length).toBe(5);
    expect(parseSideState(JSON.stringify(st), false).tabs.map((t) => t.kind)).toEqual(['changes', 'progress', 'agents', 'observe', 'files']);
  });
  it('writes a side chat out for the child session it continues in', () => {
    expect(sideTranscript([{ role: 'user', text: 'Why X?' }, { role: 'tool', text: 'Read a.ts' }, { role: 'assistant', text: 'Because Y.' }, { role: 'note', text: 'Thinking…' }]))
      .toBe('Me: Why X?\n\nClaude: Because Y.');
  });
});
