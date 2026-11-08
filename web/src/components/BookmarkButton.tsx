// ☆ on a chat message (model: web.BookmarkMessage). Panels render it only for
// messages that already have a stable anchor, and only when Review is on.
// `active` = already bookmarked: filled ★, always visible, click removes.
export function BookmarkButton({ onClick, className, active }: { onClick: () => void; className?: string; active?: boolean }) {
  const label = active ? 'Remove bookmark' : 'Bookmark this message';
  return (
    <button
      type="button"
      className={`msg-bookmark-btn ${active ? 'active' : ''} ${className ?? ''}`}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >{active ? '★' : '☆'}</button>
  );
}

// What a panel reports when ☆ is clicked; App adds the tab origin and
// decides add vs. remove (model: web.BookmarkMessage rule-438).
export type NewBookmark = { anchor: string; label: string };
