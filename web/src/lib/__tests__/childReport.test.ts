import { describe, it, expect } from 'vitest';
import { parseChildReport, parseChildReports } from '../childReport';

describe('parseChildReport', () => {
  it('reads the server\'s report format', () => {
    const text = '[Child session "Draft tests" (abc-123) finished]\n\nWrote 3 tests.\n\nAll pass.\n\n(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
    expect(parseChildReport(text)).toEqual({ title: 'Draft tests', sessionId: 'abc-123', ok: true, intervened: false, state: 'finished', body: 'Wrote 3 tests.\n\nAll pass.' });
  });
  it('marks a child that stopped with an error', () => {
    expect(parseChildReport('[Child session "T" (s1) stopped with an error (error_max_turns)]\n\nran out of turns')).toMatchObject({ ok: false, body: 'ran out of turns' });
  });
  it('flags a turn the user stepped into and keeps their words, minus the nudge to the agent', () => {
    const text = '[Child session "Draft tests" (abc-123) finished after the user stepped in]\n\nThe user spoke to this child session directly:\n\n> Unit tests only.\n\nThe child session then answered:\n\nDropped the UI tests.\n\nIf this changes your plan, adjust it; otherwise no reply is needed.\n\n(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
    const r = parseChildReport(text)!;
    expect(r).toMatchObject({ ok: true, intervened: true });
    expect(r.body).toBe('The user spoke to this child session directly:\n\n> Unit tests only.\n\nThe child session then answered:\n\nDropped the UI tests.');
  });
  it('reads how a stopped child ended', () => {
    expect(parseChildReport('[Child session "T" (s1) was stopped by the user]\n\n(no final answer)')).toMatchObject({ ok: false, state: 'was stopped by the user', intervened: false });
    expect(parseChildReport('[Child session "T" (s1) was stopped by its parent session]\n\nHalf done.')).toMatchObject({ ok: false, state: 'was stopped by its parent session' });
    expect(parseChildReport('[Child session "T" (s1) was interrupted by an aie-studio restart]\n\nThe user spoke to this child session directly:\n\n> Unit tests only.\n\nThe child session then answered:\n\n(no final answer)')).toMatchObject({ ok: false, intervened: true, state: 'was interrupted by an aie-studio restart' });
  });
  it('leaves ordinary prompts alone', () => {
    expect(parseChildReport('Please add Apple Pay')).toBeNull();
    expect(parseChildReport('[Child session notes] todo')).toBeNull();
  });
});

describe('parseChildReports', () => {
  const a = '[Child session "A" (s1) finished]\n\nFirst.\n\nMore.\n\n(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
  const b = '[Child session "B" (s2) was stopped by the user]\n\n(no final answer)';
  it('splits reports that were delivered together', () => {
    expect(parseChildReports(`${a}\n\n${b}`)!.map((r) => [r.title, r.ok, r.body])).toEqual([['A', true, 'First.\n\nMore.'], ['B', false, '(no final answer)']]);
  });
  it('reads a single report, and ignores ordinary prompts', () => {
    expect(parseChildReports(a)).toHaveLength(1);
    expect(parseChildReports('Please add Apple Pay')).toBeNull();
  });
});
