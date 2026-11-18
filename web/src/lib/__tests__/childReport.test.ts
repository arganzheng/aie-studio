import { describe, it, expect } from 'vitest';
import { parseChildReport } from '../childReport';

describe('parseChildReport', () => {
  it('reads the server\'s report format', () => {
    const text = '[Child session "Draft tests" (abc-123) finished]\n\nWrote 3 tests.\n\nAll pass.\n\n(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
    expect(parseChildReport(text)).toEqual({ title: 'Draft tests', sessionId: 'abc-123', ok: true, intervened: false, body: 'Wrote 3 tests.\n\nAll pass.' });
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
  it('leaves ordinary prompts alone', () => {
    expect(parseChildReport('Please add Apple Pay')).toBeNull();
    expect(parseChildReport('[Child session notes] todo')).toBeNull();
  });
});
