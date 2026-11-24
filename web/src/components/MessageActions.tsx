import type { ReactNode } from 'react';
import { messageTime, messageTimeFull } from '../lib/messageActions';

// Model: web.MessageActions — the row over a chat message, shown on hover
// (or tap on a phone): its time, then Copy, Copy link and Side chat; the
// message's other buttons (bookmark, rich copy) ride along in `extra`.

const Icon = ({ d }: { d: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const COPY = <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>;
const LINK = <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>;
const CHAT = <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />;

export function MessageActions({ at, onCopy, onCopyLink, onSideChat, extra }: {
  at?: number;
  onCopy: () => void;
  // Absent when the message can't be linked to yet (no id while it streams).
  onCopyLink?: () => void;
  onSideChat?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
      {at != null && <span className="msg-actions-time" title={messageTimeFull(at)}>{messageTime(at)}</span>}
      <button type="button" className="msg-actions-btn" onClick={onCopy} title="Copy (Markdown)" aria-label="Copy the message as Markdown"><Icon d={COPY} /></button>
      {onCopyLink && <button type="button" className="msg-actions-btn" onClick={onCopyLink} title="Copy link to this message" aria-label="Copy a link to this message"><Icon d={LINK} /></button>}
      {onSideChat && <button type="button" className="msg-actions-btn" onClick={onSideChat} title="Side chat about this message — read-only, doesn't interrupt the session" aria-label="Open a side chat about this message"><Icon d={CHAT} /></button>}
      {extra}
    </div>
  );
}
