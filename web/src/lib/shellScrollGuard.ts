import { logDebug } from './debugLog';

// Model: MainShell invariant — the app shell never scrolls. The project
// picker, the tab bar and the prompt input sit in a frame the size of the
// window; only what is inside the panels (messages, file tree, …) scrolls.
//
// CSS alone can't hold that: an `overflow: hidden` box can still be scrolled
// by script (scrollIntoView, focus), and the document becomes scrollable the
// moment anything ends up in the page flow below the app (a stray element, a
// browser extension's widget). Either way the tab bar slides out of view and
// only comes back after scrolling all the way up. This guard puts the shell
// back the instant it moves, and says in the debug log what made it movable.

// The boxes that make up the shell: the document, the app grid, its panels.
export function shellScrollTarget(target: EventTarget | null, doc: Document): Element | null {
  if (target === doc) return doc.scrollingElement;
  // With `overflow: hidden` on <body> (desktop) the body is its own scroll box.
  if (target === doc.body) return doc.body;
  if (target instanceof Element && (target.classList.contains('app') || target.classList.contains('panel'))) return target;
  return null;
}

function describe(el: Element): string {
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
}

// The in-flow element reaching furthest below the window: what made the page
// taller than it. Only run when the guard fires — it walks the whole DOM.
function lowestElement(): string {
  let lowest: Element | null = null;
  let bottom = window.innerHeight + 1;
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect().bottom + window.scrollY;
    if (b > bottom && getComputedStyle(el).position !== 'fixed') { bottom = b; lowest = el; }
  }
  if (!lowest) return 'nothing reaches below the window';
  const path: string[] = [];
  for (let e: Element | null = lowest; e && e !== document.body && path.length < 5; e = e.parentElement) path.push(describe(e));
  return `${path.join(' < ')} ends ${Math.round(bottom - window.innerHeight)}px below the window`;
}

const MAX_LOGGED = 5;

export function installShellScrollGuard(): () => void {
  // Touch devices are left to scroll the *document*: that is how the browser
  // keeps a focused input above the on-screen keyboard.
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  let logged = 0;
  function onScroll(e: Event) {
    const el = shellScrollTarget(e.target, document);
    if (!el || (el.scrollTop === 0 && el.scrollLeft === 0)) return;
    if ((el === document.scrollingElement || el === document.body) && !finePointer) return;
    if (logged < MAX_LOGGED) {
      logged++;
      logDebug('layout', `shell scrolled — ${describe(el)} moved to ${Math.round(el.scrollLeft)},${Math.round(el.scrollTop)} and was put back; ${lowestElement()}`);
    }
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
  // With `overflow: hidden` on the document (desktop) a too-tall page never
  // scrolls, so nothing above would report it. Say so once anyway: it is the
  // condition that used to push the tab bar away, and it means something is
  // in the page that shouldn't be.
  let reportedTall = false;
  function checkTall() {
    const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if (reportedTall || height <= window.innerHeight + 1) return;
    reportedTall = true;
    logDebug('layout', `page is taller than the window by ${height - window.innerHeight}px (kept from scrolling); ${lowestElement()}`);
  }
  const tallTimer = window.setInterval(checkTall, 10000);
  // Capture: scroll events don't bubble.
  document.addEventListener('scroll', onScroll, true);
  return () => {
    window.clearInterval(tallTimer);
    document.removeEventListener('scroll', onScroll, true);
  };
}
