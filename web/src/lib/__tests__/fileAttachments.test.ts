import { describe, expect, it } from 'vitest';
import { ATTACHED_HEAD, formatSize, parseAttachedFiles, withAttachedFiles } from '../fileAttachments';

describe('withAttachedFiles / parseAttachedFiles', () => {
  const files = [{ path: '/u/a1/spec.pdf' }, { path: '/u/b2/build log.txt' }];
  it('names the files after the prompt and reads them back', () => {
    const sent = withAttachedFiles('  Summarise these  ', files);
    expect(sent).toBe(`Summarise these\n\n${ATTACHED_HEAD}\n- /u/a1/spec.pdf\n- /u/b2/build log.txt`);
    expect(parseAttachedFiles(sent)).toEqual({ text: 'Summarise these', files: [{ path: '/u/a1/spec.pdf', name: 'spec.pdf' }, { path: '/u/b2/build log.txt', name: 'build log.txt' }] });
  });
  it('works with no typed text, and skips files that never uploaded', () => {
    expect(parseAttachedFiles(withAttachedFiles('', files)).text).toBe('');
    expect(withAttachedFiles('hi', [{}, { path: undefined }])).toBe('hi');
  });
  it('leaves ordinary text alone', () => {
    expect(parseAttachedFiles('plain')).toEqual({ text: 'plain', files: [] });
    expect(parseAttachedFiles(`quote: ${ATTACHED_HEAD}\n- /x`).files).toEqual([]);
    expect(parseAttachedFiles(`a\n${ATTACHED_HEAD}\n- /x\nand more text`).files).toEqual([]);
  });
});

describe('formatSize', () => {
  it('picks a readable unit', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(300 * 1024)).toBe('300 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
