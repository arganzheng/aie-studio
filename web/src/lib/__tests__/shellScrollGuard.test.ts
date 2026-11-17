import { describe, expect, it } from 'vitest';
import { shellScrollTarget } from '../shellScrollGuard';

// The guard only needs classList / instanceof from an element; build the
// minimum by hand so the test runs without a DOM.
class FakeElement {
  classList: { contains: (c: string) => boolean };
  constructor(classes: string[]) { this.classList = { contains: (c) => classes.includes(c) }; }
}
(globalThis as any).Element ??= FakeElement;
const el = (...classes: string[]) => Object.assign(Object.create((globalThis as any).Element.prototype), new FakeElement(classes));

describe('shellScrollTarget', () => {
  const scrolling = el();
  const body = el();
  const doc = { scrollingElement: scrolling, body } as unknown as Document;
  it('maps a document scroll to the scrolling element, and knows the body', () => {
    expect(shellScrollTarget(doc, doc)).toBe(scrolling);
    expect(shellScrollTarget(body, doc)).toBe(body);
  });
  it('treats the app grid and its panels as shell', () => {
    const app = el('app', 'no-review');
    const panel = el('panel', 'main-panel');
    expect(shellScrollTarget(app, doc)).toBe(app);
    expect(shellScrollTarget(panel, doc)).toBe(panel);
  });
  it('leaves everything that is meant to scroll alone', () => {
    expect(shellScrollTarget(el('chat-messages'), doc)).toBeNull();
    expect(shellScrollTarget(el('panel-body', 'main-body'), doc)).toBeNull();
    expect(shellScrollTarget(null, doc)).toBeNull();
  });
});
