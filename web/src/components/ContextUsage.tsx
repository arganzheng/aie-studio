import { useState } from 'react';
import { levelOf } from './ClaudeUsage';

// Context window gauge for a Claude (SDK) tab: `ctx 4%` in the status bar,
// hover for window size / tokens used, click for the /context-style card.
// The server pushes a fresh reading after every turn and model switch.

export type ContextCategory = { id: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' };
export type ContextSnapshot = {
  model: string;
  usedTokens: number;
  windowTokens: number;
  percent: number;
  autoCompactAt: number | null;
  categories: ContextCategory[];
  fetchedAt: number;
};

const fmt = (n: number) => n.toLocaleString('en-US');

// 1000000 → "1M", 200000 → "200k", 37490 → "37.5k".
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 || n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

export function contextTitle(c: ContextSnapshot): string {
  const lines = [
    `Context: ${fmt(c.usedTokens)} / ${fmt(c.windowTokens)} tokens (${c.percent}%)`,
    `Window: ${shortTokens(c.windowTokens)} · ${c.model}`,
    `Free: ${fmt(Math.max(0, c.windowTokens - c.usedTokens))} tokens`,
  ];
  if (c.autoCompactAt) lines.push(`Auto-compact at ${fmt(c.autoCompactAt)} tokens`);
  lines.push('Click for the breakdown');
  return lines.join('\n');
}

function ContextDialog({ c, onClose }: { c: ContextSnapshot; onClose: () => void }) {
  const level = levelOf(c.percent);
  const used = c.categories.filter((x) => x.kind === 'used');
  const rest = c.categories.filter((x) => x.kind !== 'used');
  const row = (x: ContextCategory) => (
    <tr key={x.id} className={`context-row context-${x.kind}`}>
      <td>{x.name}</td>
      <td className="context-num">{fmt(x.tokens)}</td>
      <td className="context-num">{((x.tokens / c.windowTokens) * 100).toFixed(1)}%</td>
    </tr>
  );
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Context window</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <ContextFacts c={c} />
            <div className="devin-quota">
              <div className="devin-quota-head">
                <span>{shortTokens(c.usedTokens)} / {shortTokens(c.windowTokens)}</span>
                <span className="devin-quota-pct" data-level={level}>{c.percent}% used</span>
              </div>
              <div className="devin-quota-track">
                <div className="devin-quota-fill" data-level={level} style={{ width: `${Math.min(100, c.percent)}%` }} />
              </div>
            </div>
            {c.categories.length > 0 && (
              <table className="context-table">
                <tbody>{used.map(row)}{rest.map(row)}</tbody>
              </table>
            )}
            <div className="settings-option-hint">
              Updated {new Date(c.fetchedAt).toLocaleTimeString()} after the last turn · same data as the CLI's <code className="settings-mono">/context</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The hover card: same facts as the tooltip text, laid out as a table.
function ContextFacts({ c }: { c: ContextSnapshot }) {
  return (
    <dl className="context-facts">
      <dt>Model</dt><dd><code className="settings-mono">{c.model}</code></dd>
      <dt>Window</dt><dd>{fmt(c.windowTokens)} tokens ({shortTokens(c.windowTokens)})</dd>
      <dt>Used</dt><dd>{fmt(c.usedTokens)} tokens ({c.percent}%)</dd>
      <dt>Free</dt><dd>{fmt(Math.max(0, c.windowTokens - c.usedTokens))} tokens</dd>
      {c.autoCompactAt != null && <><dt>Auto-compact</dt><dd>at {fmt(c.autoCompactAt)} tokens</dd></>}
    </dl>
  );
}

export function ContextBadge({ context }: { context: ContextSnapshot | null }) {
  const [open, setOpen] = useState(false);
  if (!context) {
    return <span className="context-badge pending" title="Context usage shows after the session starts">ctx …</span>;
  }
  return (
    <div className="context-badge-wrap">
      <button
        className="context-badge"
        type="button"
        data-level={levelOf(context.percent)}
        aria-label={contextTitle(context)}
        onClick={() => setOpen(true)}
      >ctx {context.percent}%</button>
      <span className="context-pop" role="tooltip">
        <ContextFacts c={context} />
        <span className="context-pop-hint">Click for the breakdown</span>
      </span>
      {open && <ContextDialog c={context} onClose={() => setOpen(false)} />}
    </div>
  );
}
