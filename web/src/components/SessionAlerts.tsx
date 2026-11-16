import { alertHeadline, type SessionEvent } from '../lib/sessionAlerts';

// Model: web.SessionAlerts — the pop-up cards. One per session, newest on
// top; a card stays until it is opened, dismissed, or the user goes to that
// session on their own. Clicking a card jumps to the session.
export type SessionAlertView = { event: SessionEvent; title: string; project: string };

const MAX_SHOWN = 4;

export function SessionAlerts({ alerts, onOpen, onDismiss, onClear }: {
  // Oldest first.
  alerts: SessionAlertView[];
  onOpen: (e: SessionEvent) => void;
  onDismiss: (e: SessionEvent) => void;
  onClear: () => void;
}) {
  if (alerts.length === 0) return null;
  const shown = alerts.slice(-MAX_SHOWN).reverse();
  const hidden = alerts.length - shown.length;
  return (
    <div className="session-alerts" role="status" aria-live="polite">
      {shown.map(({ event, title, project }) => (
        <div
          key={event.id}
          className={`session-alert ${event.kind}`}
          role="button"
          tabIndex={0}
          title="Go to this session"
          onClick={() => onOpen(event)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(event); } }}
        >
          <span className="session-alert-dot" aria-hidden="true" />
          <div className="session-alert-main">
            <div className="session-alert-title">{title}</div>
            <div className="session-alert-sub">
              <span className="session-alert-kind">{alertHeadline(event.kind)}</span>
              {project && <span> · {project}</span>}
            </div>
          </div>
          <button
            type="button"
            className="session-alert-close"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); onDismiss(event); }}
          >×</button>
        </div>
      ))}
      {alerts.length > 1 && (
        <button type="button" className="session-alerts-clear" onClick={onClear}>
          {hidden > 0 ? `+${hidden} more · ` : ''}Clear all
        </button>
      )}
    </div>
  );
}
