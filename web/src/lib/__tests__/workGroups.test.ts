import { describe, expect, it } from 'vitest';
import { changeCounts, editCounts, formatDuration, groupWork, isStructured, asksUser, type WorkMsg } from '../workGroups';

let n = 0;
const user = (): WorkMsg => ({ id: `u${n++}`, role: 'user' });
const text = (t: string, at?: number): WorkMsg => ({ id: `a${n++}`, role: 'assistant', text: t, at });
const think = (at?: number, ms?: number): WorkMsg => ({ id: `k${n++}`, role: 'thinking', text: '', at, ms });
const tool = (name: string, input: any = {}, at?: number, doneAt?: number, output = 'ok', step?: string): WorkMsg => ({ id: `t${n++}`, role: 'tool', name, input, at, doneAt, output, step });
const kinds = (items: ReturnType<typeof groupWork>) => items.map((i) => (i.kind === 'group' ? `G${i.steps}` : i.msg.role === 'assistant' ? 'T' : i.msg.role === 'tool' ? 'C' : i.msg.role[0].toUpperCase()));

describe('work groups', () => {
  it('keeps notes inside the work and ends a group at messages meant for the user', () => {
    const items = groupWork([
      user(), text('Plan: do X.'), tool('Bash'), text('Next, the server:'), tool('Read'), tool('Edit', { old_string: 'a', new_string: 'b' }),
      text('Tests pass; now the screenshots.'), tool('Bash'),
      text('Which port should I use?'), tool('Bash'), text('Done: all good.'),
    ], false);
    // "Plan: do X." is followed by tools and is short: a note. The question breaks.
    expect(kinds(items)).toEqual(['U', 'G4', 'T', 'G1', 'T']);
    const g = items[1];
    expect(g.kind === 'group' && g.rows.map((r) => r.kind)).toEqual(['note', 'tool', 'note', 'tool', 'edit', 'note', 'tool']);
  });
  it('lets a structured report break the work', () => {
    const items = groupWork([user(), tool('Bash'), text('Found:\n- one\n- two'), tool('Bash'), text('ok')], false);
    expect(kinds(items)).toEqual(['U', 'G1', 'T', 'G1', 'T']);
  });
  it('folds calls made in one response into one row, keeps edits and tasks apart', () => {
    const items = groupWork([
      user(), tool('Bash', {}, undefined, undefined, 'ok', 's1'), tool('Read', {}, undefined, undefined, 'ok', 's1'), tool('Grep', {}, undefined, undefined, 'ok', 's1'),
      tool('TaskCreate', { subject: 'Ship it' }, undefined, undefined, 'Task #7 created successfully: Ship it'),
      tool('TaskUpdate', { taskId: '7', status: 'in_progress' }),
      tool('Bash'), tool('Bash'), think(), tool('Write', { content: 'a\nb\n' }), text('done'),
    ], false);
    const g = items[1];
    if (g.kind !== 'group') throw new Error('no group');
    expect(g.rows.map((r) => r.kind)).toEqual(['batch', 'task', 'task', 'tool', 'tool', 'thought', 'edit']);
    expect(g.rows[2].kind === 'task' && g.rows[2].label).toBe('Started task Ship it');
    expect(g.add).toBe(2);
    expect(g.steps).toBe(8);
  });
  it('times the work and the thinking, and marks the last group running', () => {
    const items = groupWork([user(), think(10_000), tool('Bash', {}, 12_000, 20_000), think(27_000), tool('Bash', {}, 27_500)], true);
    const g = items[1];
    if (g.kind !== 'group') throw new Error('no group');
    expect(g.start).toBe(10_000);
    expect(g.end).toBe(27_500);
    expect(g.running).toBe(true);
    // The second thought: 20 s (previous call done) → 27 s.
    expect(g.rows[2]).toMatchObject({ kind: 'thought', ms: 7_000 });
  });
  it('calls a group of only thinking a thought', () => {
    const items = groupWork([user(), think(1, 9_000), text('Sure.')], false);
    expect(items[1]).toMatchObject({ kind: 'group', thoughtOnly: true, steps: 0 });
  });
  it('never folds a question form', () => {
    expect(kinds(groupWork([user(), tool('Bash'), tool('AskUserQuestion'), tool('Bash'), text('x')], false))).toEqual(['U', 'G1', 'C', 'G1', 'T']);
  });
  it('counts changed lines', () => {
    expect(changeCounts('a\nb\nc', 'a\nB\nc\nd')).toEqual({ add: 2, del: 1 });
    expect(editCounts('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y\nz' }] })).toEqual({ add: 2, del: 1 });
    expect(editCounts('Write', { content: 'one\ntwo\n' })).toEqual({ add: 2, del: 0 });
  });
  it('tells reports and questions', () => {
    expect(isStructured('| a | b |')).toBe(true);
    expect(isStructured('Next, the tests:')).toBe(false);
    expect(asksUser('要我继续吗？')).toBe(true);
    expect(asksUser('Done.\n<!--status needs-you: Pick one-->')).toBe(true);
  });
  it('formats durations', () => {
    expect(formatDuration(39_400)).toBe('39s');
    expect(formatDuration(127_000)).toBe('2m 7s');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
  });
});
