import { useLayoutEffect, useState, type RefObject } from 'react';

const MARGIN = 4;

// Model: web.FileTree rule-076 (and the ⋯ menus of GroupList / ReviewPanel).
// A row menu opens below its button at `requestedTop`; near the bottom of
// the viewport that would run off-screen and get clipped. Measure the
// rendered menu once per open and pull it up so it fits — returns the top
// to actually use. State (not an imperative style write) so a parent
// re-render while the menu is open (e.g. the FileTree's 3s poll) cannot
// snap it back to the clipped position.
export function useFitMenuTop(
  ref: RefObject<HTMLElement | null>,
  open: unknown,
  requestedTop: number,
): number {
  const [fitTop, setFitTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    setFitTop(null);
    const el = ref.current;
    if (!el || !open) return;
    const h = el.getBoundingClientRect().height;
    const maxTop = window.innerHeight - h - MARGIN;
    if (requestedTop > maxTop) setFitTop(Math.max(MARGIN, maxTop));
  }, [ref, open, requestedTop]);
  return fitTop ?? requestedTop;
}
