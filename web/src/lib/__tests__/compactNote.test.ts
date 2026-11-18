import { describe, expect, it } from 'vitest';
import { parseCompactNote } from '../compactNote';

describe('parseCompactNote', () => {
  it('recognizes the summary a compaction leaves', () => {
    const text = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. …';
    expect(parseCompactNote(text)).toEqual({ kind: 'summary', summary: text });
  });
  it('recognizes the command output', () => {
    expect(parseCompactNote('<local-command-stdout>Compacted </local-command-stdout>')).toEqual({ kind: 'done' });
    expect(parseCompactNote('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>')).toEqual({ kind: 'done' });
    expect(parseCompactNote('<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>')).toEqual({ kind: 'done' });
  });
  it('leaves ordinary messages alone', () => {
    expect(parseCompactNote('please compact this')).toBeNull();
    expect(parseCompactNote('<command-name>/model</command-name>')).toBeNull();
    expect(parseCompactNote('<local-command-stdout>hello</local-command-stdout>')).toBeNull();
    expect(parseCompactNote('I said: This session is being continued from a previous conversation that ran out of context.')).toBeNull();
  });
});
