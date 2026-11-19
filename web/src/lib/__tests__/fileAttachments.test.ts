import { describe, expect, it } from 'vitest';
import { ATTACHED_HEAD, dragHasFiles, droppedFiles, formatSize, parseAttachedFiles, withAttachedFiles } from '../fileAttachments';

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

describe('drag and drop', () => {
  const file = (name: string, type: string) => ({ name, type }) as File;
  const item = (f: File | null, dir = false, kind = 'file') => ({ kind, getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: dir }) });
  it('tells a file drag from a text drag', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain', 'text/uri-list'])).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
  it('takes the files and leaves folders and text behind', () => {
    const pdf = file('a.pdf', 'application/pdf'); const png = file('b.png', 'image/png');
    const items = [item(pdf), item(png), item(file('dir', ''), true), item(null, false, 'string')];
    expect(droppedFiles(items, true)).toEqual([pdf, png]);
    expect(droppedFiles(items, false)).toEqual([png]);
    expect(droppedFiles(null, true)).toEqual([]);
  });
});
