import { describe, it, expect } from 'vitest';
import { parseChildReport } from '../childReport';

describe('parseChildReport', () => {
  it('reads the server\'s report format', () => {
    const text = '[Child session "Draft tests" (abc-123) finished]\n\nWrote 3 tests.\n\nAll pass.\n\n(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
    expect(parseChildReport(text)).toEqual({ title: 'Draft tests', sessionId: 'abc-123', ok: true, body: 'Wrote 3 tests.\n\nAll pass.' });
  });
  it('marks a child that stopped with an error', () => {
    expect(parseChildReport('[Child session "T" (s1) stopped with an error (error_max_turns)]\n\nran out of turns')).toMatchObject({ ok: false, body: 'ran out of turns' });
  });
  it('leaves ordinary prompts alone', () => {
    expect(parseChildReport('Please add Apple Pay')).toBeNull();
    expect(parseChildReport('[Child session notes] todo')).toBeNull();
  });
});
