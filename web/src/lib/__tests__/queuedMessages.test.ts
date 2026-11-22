import { describe, expect, it } from 'vitest';
import { parseQueue } from '../../components/QueuedMessages';

describe('parseQueue', () => {
  it('keeps well-formed items and drops the rest', () => {
    expect(parseQueue([{ id: 'a', text: 'hi', images: 2, at: 5 }, { text: 'no id' }, null, { id: 'b' }])).toEqual([
      { id: 'a', text: 'hi', images: 2, at: 5 },
      { id: 'b', text: '', images: 0, at: 0 },
    ]);
    expect(parseQueue(undefined)).toEqual([]);
  });
});
