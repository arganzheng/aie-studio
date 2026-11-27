// Model: web.AppVersion — a page keeps running the front end it loaded. After
// a deploy the server hands out a new one (its entry script's name carries
// the build hash), so the page asks for index.html now and then and offers a
// reload when the entry script there is not the one it runs. It never
// reloads by itself: that could lose what the user is typing.
import { useEffect, useState } from 'react';
import { CONNECTED_EVENT } from './duplex';

const ENTRY_RE = /src="(\/assets\/index-[^"]+\.js)"/;
const CHECK_EVERY_MS = 10 * 60_000;
const MIN_GAP_MS = 10_000;

/** The entry script named in an index.html; null when there is none (dev server). */
export function entryInHtml(html: string): string | null {
  return ENTRY_RE.exec(html)?.[1] ?? null;
}

/** The entry script this page runs; null under the dev server. */
export function loadedEntry(doc: Document = document): string | null {
  const s = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src, doc.baseURI).pathname : null;
}

/** Whether a check found a front end newer than the loaded one. */
export function isNewer(loaded: string | null, latest: string | null): boolean {
  return !!loaded && !!latest && loaded !== latest;
}

/** The entry script of the front end the server now hands out (null: unknown). */
export function useNewVersion(): string | null {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    const loaded = loadedEntry();
    if (!loaded) return;
    let last = 0;
    let stopped = false;
    const check = async () => {
      if (stopped || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      try {
        const r = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
        if (!r.ok) return;
        const found = entryInHtml(await r.text());
        if (isNewer(loaded, found)) setLatest(found);
      } catch { /* offline: try again later */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener(CONNECTED_EVENT, check);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(onVisible, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      window.removeEventListener(CONNECTED_EVENT, check);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);
  return latest;
}
