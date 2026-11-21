import { describe, expect, it } from 'vitest';
import { historyProblem } from '../../components/HistoryNotice';

describe('historyProblem', () => {
  it('names what went wrong', () => {
    expect(historyProblem(null, null, null)).toMatch(/reach the server/);
    expect(historyProblem({ ok: false, status: 404 }, null, null)).toMatch(/not found/);
    expect(historyProblem({ ok: false, status: 500 }, null, null)).toMatch(/HTTP 500/);
    expect(historyProblem({ ok: true, status: 200 }, 0, 0)).toMatch(/No messages/);
  });
  it('is quiet when there is history', () => {
    expect(historyProblem({ ok: true, status: 200 }, 20, 300)).toBeNull();
    expect(historyProblem({ ok: true, status: 200 }, 0, 5)).toBeNull();
  });
});
