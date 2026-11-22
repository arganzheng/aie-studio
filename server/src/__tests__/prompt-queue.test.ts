import { describe, expect, it } from 'vitest';
import { editQueued, mergeQueued, queueView, type QueuedPrompt } from '../prompt-queue.js';

const img = { mediaType: 'image/png', data: 'AAA' };
const q = (id: string, text: string, images = 0): QueuedPrompt => ({ id, text, images: Array.from({ length: images }, () => img), at: 1 });

describe('prompt queue', () => {
  it('merges texts in order with a blank line between, images after', () => {
    expect(mergeQueued([q('a', ' first '), q('b', ''), q('c', 'second', 2)])).toEqual({ text: 'first\n\nsecond', images: [img, img] });
  });
  it('shows clients counts, not image data', () => {
    expect(queueView([q('a', 'x', 1)])).toEqual([{ id: 'a', text: 'x', images: 1, at: 1 }]);
    expect(queueView([{ ...q('b', 'y'), interrupt: true }])[0].interrupt).toBe(true);
  });
  it('edits one item and drops it when emptied, unless it carries images', () => {
    const items = [q('a', 'one'), q('b', 'two', 1)];
    expect(editQueued(items, 'a', 'uno').map((x) => x.text)).toEqual(['uno', 'two']);
    expect(editQueued(items, 'a', '  ').map((x) => x.id)).toEqual(['b']);
    expect(editQueued(items, 'b', '').map((x) => x.id)).toEqual(['a', 'b']);
    expect(editQueued(items, 'zzz', 'x')).toEqual(items);
  });
});
