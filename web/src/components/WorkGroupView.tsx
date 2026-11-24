import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { batchLabel, formatDuration, toolFailed, toolLine, type WorkGroup, type WorkMsg, type WorkRow } from '../lib/workGroups';

type Tool = Extract<WorkMsg, { role: 'tool' }>;

// Model: web.WorkGroups — one stretch of Claude's work between messages.
// Running: open, a fixed-height window that follows the newest row. Done:
// one line ("Worked for 2m 7s +303 −13"), opened on click.
export function WorkGroupView({ group, background = 0, rel, renderDetail, renderForm, renderNote, onOpenChild, childOf, onImage }: {
  group: WorkGroup;
  // The turn is over but this many background tasks it started still run.
  background?: number;
  rel: (s: string) => string;
  renderDetail: (tool: Tool) => ReactNode;
  // A form a tool call waits on (an MCP elicitation): always shown.
  renderForm: (toolUseId: string | undefined) => ReactNode;
  renderNote: (text: string) => ReactNode;
  onOpenChild?: (tool: Tool) => void;
  childOf?: (tool: Tool) => boolean;
  onImage: (src: string) => void;
}) {
  // null: follow the group (open while running, closed when done).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? group.running;
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = (key: string) => setOpenRows((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  // The running clock in the header.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!group.running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [group.running]);

  // Follow the newest row while running, unless the user scrolled up.
  const bodyRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && group.running && stuck.current) el.scrollTop = el.scrollHeight;
  });

  const until = group.running ? now : group.end;
  const took = group.start != null && until != null ? formatDuration(until - group.start) : null;
  const title = group.running ? 'Working' : group.thoughtOnly ? 'Thought' : 'Worked';

  const toolRow = (t: Tool, key: string) => {
    const running = group.running && t.output === undefined;
    const line = toolLine(t.name, t.input, rel, running);
    const failed = toolFailed(t);
    const isOpen = openRows.has(key);
    const images = (t as { outputImages?: string[] }).outputImages ?? [];
    const toolUseId = (t as { toolUseId?: string }).toolUseId;
    return (
      <div key={key} className="work-item">
        <div className={`work-row${running ? ' running' : ''}${failed ? ' failed' : ''}`} onClick={() => toggleRow(key)} title={line.detail || undefined}>
          <span className="work-verb">{failed ? `${line.verb} · failed` : line.verb}</span>
          {line.desc && <span className="work-desc">{line.desc}</span>}
          {line.detail && <span className="work-cmd">{line.detail}</span>}
          {childOf?.(t) && onOpenChild && (
            <button type="button" className="work-open-child" onClick={(e) => { e.stopPropagation(); onOpenChild(t); }} title="Open this child session in its own tab">⑂ Open</button>
          )}
          <span className="work-chev" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
        </div>
        {isOpen && renderDetail(t)}
        {images.length > 0 && (
          <div className="work-images">
            {images.map((src, i) => <img key={i} src={src} className="tool-image" alt="" loading="lazy" onClick={() => onImage(src)} />)}
          </div>
        )}
        {renderForm(toolUseId)}
      </div>
    );
  };

  const row = (r: WorkRow, idx: number) => {
    const key = `${group.id}:${idx}`;
    switch (r.kind) {
      case 'tool': return toolRow(r.tool, key);
      case 'edit': {
        const isOpen = openRows.has(key);
        const line = toolLine(r.tool.name, r.tool.input, rel, false);
        return (
          <div key={key} className="work-item">
            <div className={`work-row${toolFailed(r.tool) ? ' failed' : ''}`} onClick={() => toggleRow(key)}>
              <span className="work-verb">{line.verb}</span>
              <span className="work-desc">{line.desc}</span>
              {r.add > 0 && <span className="work-add">+{r.add}</span>}
              {r.del > 0 && <span className="work-del">−{r.del}</span>}
              <span className="work-chev" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
            </div>
            {isOpen && renderDetail(r.tool)}
          </div>
        );
      }
      case 'task': return (
        <div key={key} className="work-item">
          <div className="work-row work-task"><span className="work-desc">{r.label}</span></div>
        </div>
      );
      case 'batch': {
        const isOpen = openRows.has(key);
        const running = group.running && r.tools.some((t) => t.output === undefined);
        const failed = r.tools.filter(toolFailed).length;
        return (
          <div key={key} className="work-item">
            <div className={`work-row${running ? ' running' : ''}`} onClick={() => toggleRow(key)}>
              <span className="work-verb">{batchLabel(r.tools)}</span>
              {failed > 0 && <span className="work-del">· {failed} failed</span>}
              <span className="work-chev" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
            </div>
            {isOpen
              ? <div className="work-batch">{r.tools.map((t, i) => toolRow(t, `${key}:${i}`))}</div>
              : r.tools.map((t) => <span key={t.id}>{renderForm((t as { toolUseId?: string }).toolUseId)}</span>)}
          </div>
        );
      }
      case 'thought': {
        const text = r.thoughts.map((t) => t.text.trim()).filter(Boolean).join('\n\n');
        // Nothing to read and too short to matter: no row.
        if (!text && (r.ms == null || r.ms < 1000) && !(group.running && idx === group.rows.length - 1)) return null;
        const isOpen = openRows.has(key) && !!text;
        const label = r.thoughts.length > 1 ? 'Thoughts' : r.ms != null && r.ms >= 1000 ? `Thought for ${formatDuration(r.ms)}` : 'Thought';
        return (
          <div key={key} className="work-item">
            <div className={`work-row work-thought${text ? '' : ' empty'}`} onClick={() => text && toggleRow(key)}>
              <span className="work-verb">{label}</span>
              {text && <span className="work-chev" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>}
            </div>
            {isOpen && <div className="work-thought-text">{text}</div>}
          </div>
        );
      }
      case 'note': return <div key={key} className="work-item work-note">{renderNote(r.note.text)}</div>;
      case 'notice': return (
        <Fragment key={key}>
          {r.notes.map((n, i) => {
            const k = `${key}:${i}`;
            const isOpen = openRows.has(k);
            return (
              <div key={k} className="work-item work-notice">
                <div className="work-row" onClick={() => n.result && toggleRow(k)} title={n.ids.length ? `Task ${n.ids.join(', ')}` : undefined}>
                  <span className={`work-notice-mark ${n.status === 'completed' ? 'ok' : 'off'}`} aria-hidden="true">{n.status === 'completed' ? '✓' : '■'}</span>
                  <span className="work-desc">{n.summary}</span>
                  {n.result && <span className="work-chev" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>}
                </div>
                {isOpen && n.result && <div className="work-notice-result">{renderNote(n.result)}</div>}
              </div>
            );
          })}
        </Fragment>
      );
    }
  };

  // A group of only thinking: its text is the content.
  if (group.thoughtOnly) {
    const text = group.rows.flatMap((r) => (r.kind === 'thought' ? r.thoughts.map((t) => t.text.trim()) : [])).filter(Boolean).join('\n\n');
    const ms = group.start != null && group.end != null ? group.end - group.start : null;
    if (!group.running && !text && (ms == null || ms < 1000)) return null;
    return (
      <div className="work-group thought-only">
        <div className="work-head" onClick={() => text && setUserOpen(!open)}>
          <span className="work-head-chev" aria-hidden="true">{text ? (open ? '⌄' : '›') : ''}</span>
          <span className="work-head-title">{group.running ? 'Thinking' : 'Thought'}{took ? ` for ${took}` : ''}</span>
        </div>
        {open && text && <div className="work-body"><div className="work-thought-text">{text}</div></div>}
      </div>
    );
  }

  return (
    <div className={`work-group${group.running ? ' running' : ''}`}>
      <div className="work-head" onClick={() => setUserOpen(!open)}>
        <span className="work-head-chev" aria-hidden="true">{open ? '⌄' : '›'}</span>
        <span className="work-head-title">{title}{took ? ` for ${took}` : ''}</span>
        {group.running && background > 0 && <span className="work-head-bg"> · in the background ({background} task{background === 1 ? '' : 's'})</span>}
        {group.add > 0 && <span className="work-add">+{group.add}</span>}
        {group.del > 0 && <span className="work-del">−{group.del}</span>}
        {group.steps > 0 && <span className="work-steps">· {group.steps} step{group.steps === 1 ? '' : 's'}</span>}
      </div>
      {open && (
        <div
          ref={bodyRef}
          className={`work-body${group.running ? ' live' : ''}`}
          onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        >
          {group.rows.map(row)}
        </div>
      )}
      {/* A form a call waits on stays reachable with the group closed. */}
      {!open && group.msgs.map((m) => (m.role === 'tool' ? <span key={m.id}>{renderForm((m as { toolUseId?: string }).toolUseId)}</span> : null))}
    </div>
  );
}
