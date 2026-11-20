import { describe, expect, it } from 'vitest';
import { isImageSizeNote, parseToolResultContent } from '../toolResult';

describe('parseToolResultContent', () => {
  it('passes string content through', () => {
    expect(parseToolResultContent('hello')).toEqual({ text: 'hello' });
  });

  it('joins text blocks', () => {
    expect(parseToolResultContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ text: 'a\nb' });
  });

  it('extracts base64 images as data URLs', () => {
    const out = parseToolResultContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    expect(out).toEqual({ text: '', images: ['data:image/png;base64,AAAA'] });
  });

  it('keeps text alongside images', () => {
    const out = parseToolResultContent([
      { type: 'text', text: 'shot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ]);
    expect(out).toEqual({ text: 'shot', images: ['data:image/jpeg;base64,BBBB'] });
  });

  it('stringifies other shapes', () => {
    expect(parseToolResultContent({ x: 1 })).toEqual({ text: '{"x":1}' });
  });
});

describe('isImageSizeNote', () => {
  const note = '[Image: original 2560x1520, displayed at 2000x1188. Multiply coordinates by 1.28 to map to original image.]';

  it('matches the isMeta string note', () => {
    expect(isImageSizeNote({ type: 'user', isMeta: true, message: { role: 'user', content: note } })).toBe(true);
  });

  it('matches the live SDK note (isSynthetic)', () => {
    expect(isImageSizeNote({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: note }] } })).toBe(true);
  });

  it('matches a single text block note', () => {
    expect(isImageSizeNote({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: note }] } })).toBe(true);
  });

  it('ignores the same text typed by the user (not isMeta)', () => {
    expect(isImageSizeNote({ type: 'user', message: { content: note } })).toBe(false);
  });

  it('ignores other isMeta records', () => {
    expect(isImageSizeNote({ type: 'user', isMeta: true, message: { content: 'Base directory for this skill: …' } })).toBe(false);
  });
});
