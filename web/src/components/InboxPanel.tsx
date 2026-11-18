import { useEffect, useState } from 'react';
import { alertHeadline } from '../lib/sessionAlerts';
import { shortAge, type InboxFilter, type InboxItem } from '../lib/inbox';

// Model: web.Inbox — the notification history column. Opens beside the
// sidebar from the inbox button (full screen on phones). Newest first; an
// unread row has a dot and a bold title. Clicking a row goes to its session
// and marks it read.
export type InboxRowView = { item: InboxItem; title: string; project: string };

export function InboxButton({ unread, open, onToggle }: { unread: number; open: boolean; onToggle: () => void }) {
  const label = unread > 0 ? `Notifications (${unread} unread)` : 'Notifications';
  return (
    <button
      type="button"
      className={`inbox-button${open ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 9.5 3.8 3.2A1 1 0 0 1 4.8 2.5h6.4a1 1 0 0 1 1 .7L14 9.5V13a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 2 13V9.5Z" />
        <path d="M2 9.5h3.2l.8 1.6h4l.8-1.6H14" />
      </svg>
      {unread > 0 && <span className="inbox-button-dot" aria-hidden="true" />}
    </button>
  );
}

export function InboxPanel({ rows, unread, hasMore, loading, onOpen, onMarkRead, onMarkAllRead, onRemove, onClearAll, onLoadMore, onClose }: {
  rows: InboxRowView[];
  unread: number;
  hasMore: boolean;
  loading: boolean;
  onOpen: (item: InboxItem) => void;
  onMarkRead: (item: InboxItem) => void;
  onMarkAllRead: () => void;
  onRemove: (item: InboxItem) => void;
  onClearAll: () => void;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = filter === 'unread' ? rows.filter((r) => r.item.readAt === null) : rows;
  return (
    <aside className="inbox-panel" aria-label="Notifications">
      <div className="inbox-head">
        <span className="inbox-title">Notifications</span>
        <button type="button" className="inbox-icon-btn" title="Mark all as read" aria-label="Mark all as read" disabled={unread === 0} onClick={onMarkAllRead}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1.5 8.5 4.5 11.5 10.5 4.5" /><path d="M7.5 11.5 14.5 4.5" />
          </svg>
        </button>
        <button
          type="button"
          className="inbox-icon-btn"
          title="Clear all notifications"
          aria-label="Clear all notifications"
          disabled={rows.length === 0}
          onClick={() => { if (window.confirm('Clear all notifications?')) onClearAll(); }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 4h11" /><path d="M6 4V2.5h4V4" /><path d="M4 4l.7 9.5h6.6L12 4" />
          </svg>
        </button>
        <button type="button" className="inbox-icon-btn" title="Close" aria-label="Close notifications" onClick={onClose}>×</button>
      </div>
      <div className="inbox-filters" role="tablist">
        {(['all', 'unread'] as const).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : 'Unread'}
            {f === 'unread' && unread > 0 && <span className="inbox-filter-count">{unread}</span>}
          </button>
        ))}
      </div>
      <div className="inbox-list">
        {shown.length === 0 && !loading && (
          <div className="inbox-empty">{filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}</div>
        )}
        {shown.map(({ item, title, project }) => {
          const isUnread = item.readAt === null;
          return (
            <div
              key={item.id}
              className={`inbox-row ${item.kind}${isUnread ? ' unread' : ''}`}
              role="button"
              tabIndex={0}
              title="Go to this session"
              onClick={() => onOpen(item)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); } }}
            >
              <span className="inbox-row-icon" aria-hidden="true">{item.kind === 'awaiting' ? '?' : '✓'}</span>
              <div className="inbox-row-main">
                <div className="inbox-row-top">
                  <span className="inbox-row-title">{title}</span>
                  <span className="inbox-row-age" title={new Date(item.at).toLocaleString()}>{shortAge(item.at, now)}</span>
                </div>
                {item.summary && <div className="inbox-row-summary">{item.summary}</div>}
                <div className="inbox-row-meta">
                  <span className="inbox-row-kind">{alertHeadline(item.kind)}</span>
                  {project && <span> · {project}</span>}
                </div>
              </div>
              <div className="inbox-row-actions">
                {isUnread && <span className="inbox-row-dot" aria-label="Unread" />}
                {isUnread && (
                  <button type="button" className="inbox-row-btn" title="Mark as read" aria-label="Mark as read" onClick={(e) => { e.stopPropagation(); onMarkRead(item); }}>✓</button>
                )}
                <button type="button" className="inbox-row-btn" title="Remove" aria-label="Remove" onClick={(e) => { e.stopPropagation(); onRemove(item); }}>×</button>
              </div>
            </div>
          );
        })}
        {loading && <div className="inbox-empty">Loading…</div>}
        {hasMore && !loading && filter === 'all' && (
          <button type="button" className="inbox-more" onClick={onLoadMore}>Load older</button>
        )}
      </div>
    </aside>
  );
}
