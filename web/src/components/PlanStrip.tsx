import { useState } from 'react';
import { planSummary, type PlanItem } from '../lib/plan';

// Model: web.PlanStrip — the agent's task list, pinned above the messages so
// it stays in sight however far the chat scrolls. Folded it is one line:
// progress and the item in progress; tap to see the whole list.

const MARK: Record<PlanItem['status'], string> = { completed: '✓', in_progress: '▸', pending: '○' };

export function PlanStrip({ plan }: { plan: readonly PlanItem[] | null }) {
  const [open, setOpen] = useState(false);
  if (!plan || plan.length === 0) return null;
  const { done, total, current } = planSummary(plan);
  const allDone = done === total;
  const now = allDone
    ? 'All done'
    : current?.status === 'in_progress'
      ? current.active || current.text
      : current ? `Next: ${current.text}` : '';
  return (
    <div className={`plan-strip${open ? ' open' : ''}${allDone ? ' all-done' : ''}`}>
      <button
        type="button"
        className="plan-strip-head"
        aria-expanded={open}
        title={open ? 'Hide the task list' : 'Show the task list'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="plan-strip-label">Plan</span>
        <span className="plan-strip-count">{done}/{total}</span>
        <span className="plan-strip-bar" aria-hidden="true"><span style={{ width: `${(done / total) * 100}%` }} /></span>
        <span className="plan-strip-now">{now}</span>
        <span className="plan-strip-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ol className="plan-strip-list">
          {plan.map((it, i) => (
            <li key={it.id ?? i} className={`plan-item ${it.status}`}>
              <span className="plan-item-mark" aria-label={it.status.replace('_', ' ')}>{MARK[it.status]}</span>
              <span className="plan-item-text">{it.status === 'in_progress' && it.active ? it.active : it.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
