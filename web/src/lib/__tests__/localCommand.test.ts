import { describe, expect, it } from 'vitest';
import { absorbCompactSummary, answerTypedCommand, giveSummaryToCompact, applyLocalCommandOutput, attachLocalCommandOutput, isSyntheticReply, localCommandOutputOf, localCommandText, localCommandView, splitLocalCommandTexts } from '../localCommand';
import { withArrivedDuring } from '../refetchMerge';

const CAVEAT = "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>";
const COMMAND = '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>fable</command-args>';
const STDOUT = '<local-command-stdout>Set model to `fable (claude-fable-5-2)`</local-command-stdout>';

describe('splitLocalCommandTexts', () => {
  it('reads the three transcript records', () => {
    expect(splitLocalCommandTexts([CAVEAT])).toEqual([{ kind: 'caveat' }]);
    expect(splitLocalCommandTexts([COMMAND])).toEqual([{ kind: 'command', command: '/model fable' }]);
    expect(splitLocalCommandTexts([STDOUT])).toEqual([{ kind: 'output', stdout: 'Set model to `fable (claude-fable-5-2)`', stderr: '' }]);
  });

  it('reads them when they arrive as one text', () => {
    expect(splitLocalCommandTexts([`${CAVEAT}\n${COMMAND}\n${STDOUT}`]).map((p) => p.kind)).toEqual(['caveat', 'command', 'output']);
  });

  it('reads a command without args and stderr', () => {
    expect(splitLocalCommandTexts(['<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>']))
      .toEqual([{ kind: 'command', command: '/context' }]);
    expect(splitLocalCommandTexts(['<local-command-stderr>Unknown model: foo</local-command-stderr>']))
      .toEqual([{ kind: 'output', stdout: '', stderr: 'Unknown model: foo' }]);
  });

  it('strips ANSI colours', () => {
    expect(splitLocalCommandTexts(['<local-command-stdout>\x1b[1mBold\x1b[0m text</local-command-stdout>']))
      .toEqual([{ kind: 'output', stdout: 'Bold text', stderr: '' }]);
  });

  it('leaves prompts alone, also ones that mention a tag', () => {
    expect(splitLocalCommandTexts(['hello'])).toEqual([{ kind: 'text', text: 'hello' }]);
    const quoted = `why does ${STDOUT} show up?`;
    expect(splitLocalCommandTexts([quoted])).toEqual([{ kind: 'text', text: quoted }]);
  });

  it('reads /compact like any command, without the terminal key hint', () => {
    const cmd = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>';
    const out = '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>';
    expect(splitLocalCommandTexts([cmd, out])).toEqual([{ kind: 'command', command: '/compact' }, { kind: 'output', stdout: 'Compacted', stderr: '' }]);
  });
});

describe('attachLocalCommandOutput', () => {
  const out = { stdout: 'ok', stderr: '' };

  it('fills the latest command', () => {
    const msgs: any[] = [{ role: 'user' }, { role: 'localcmd', command: '/model fable' }];
    expect(attachLocalCommandOutput(msgs, out)).toBe(true);
    expect(msgs[1].output).toEqual(out);
  });

  it('refuses when there is no command waiting', () => {
    expect(attachLocalCommandOutput([{ role: 'user' }], out)).toBe(false);
    expect(attachLocalCommandOutput([{ role: 'localcmd', command: '/a', output: out } as any], out)).toBe(false);
  });
});

describe('localCommandView', () => {
  it('puts a short output on the command line, without code marks', () => {
    expect(localCommandView({ command: '/model fable', output: { stdout: 'Set model to `fable`', stderr: '' } }))
      .toEqual({ failed: false, inline: 'Set model to fable', body: null });
  });

  it('gives a long output its own block', () => {
    const v = localCommandView({ command: '/context', output: { stdout: 'a\nb', stderr: '' } });
    expect(v).toEqual({ failed: false, inline: null, body: 'a\nb' });
  });

  it('marks stderr as failed', () => {
    expect(localCommandView({ command: '/model foo', output: { stdout: '', stderr: 'Unknown model' } }).failed).toBe(true);
  });

  it('handles a command still waiting for output', () => {
    expect(localCommandView({ command: '/model fable' })).toEqual({ failed: false, inline: null, body: null });
  });
});

describe('localCommandText', () => {
  it('joins command and output', () => {
    expect(localCommandText({ command: '/model fable', output: { stdout: 'Set model', stderr: '' } })).toBe('/model fable → Set model');
    expect(localCommandText({ command: '/context', output: { stdout: 'a\nb', stderr: '' } })).toBe('/context\na\nb');
  });
});

describe('applyLocalCommandOutput', () => {
  const out = { stdout: 'ok', stderr: '' };
  const make = (command: string, output: typeof out) => ({ role: 'localcmd', command, output }) as any;

  it('turns the slash command the user just typed into the card', () => {
    const msgs: any[] = [{ role: 'user', text: '/model fable' }];
    applyLocalCommandOutput(msgs, out, make);
    expect(msgs).toEqual([{ role: 'localcmd', command: '/model fable', output: out }]);
  });

  it('adds a card of its own after anything else', () => {
    const msgs: any[] = [{ role: 'user', text: 'hello' }];
    applyLocalCommandOutput(msgs, out, make);
    expect(msgs).toEqual([{ role: 'user', text: 'hello' }, { role: 'localcmd', command: '', output: out }]);
  });
});

describe('localCommandOutputOf', () => {
  it('reads the transcript system record', () => {
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>' }))
      .toEqual({ stdout: 'Set model to `Sonnet 5.5`', stderr: '' });
  });

  it('reads the live SDK message, tagged or plain', () => {
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command_output', content: 'Set model' })).toEqual({ stdout: 'Set model', stderr: '' });
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command_output', content: '<local-command-stderr>bad</local-command-stderr>' }))
      .toEqual({ stdout: '', stderr: 'bad' });
  });

  it('ignores other records', () => {
    expect(localCommandOutputOf({ type: 'system', subtype: 'init' })).toBeNull();
    expect(localCommandOutputOf({ type: 'user', message: { content: 'x' } })).toBeNull();
  });

  it('reads compaction output, without the terminal key hint', () => {
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' }))
      .toEqual({ stdout: 'Compacted', stderr: '' });
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command_output', content: 'Compacted (ctrl+o to see full summary)' }))
      .toEqual({ stdout: 'Compacted', stderr: '' });
  });
});

describe('answerTypedCommand', () => {
  const make = (command: string, output: { stdout: string; stderr: string }) => ({ role: 'localcmd', command, output }) as any;

  it('folds the answer into the slash command typed before it', () => {
    const msgs: any[] = [{ role: 'assistant', text: 'hi' }, { role: 'user', text: '/model sonnet' }];
    expect(answerTypedCommand(msgs, 'Set model to Sonnet', make)).toBe(true);
    expect(msgs[1]).toEqual({ role: 'localcmd', command: '/model sonnet', output: { stdout: 'Set model to Sonnet', stderr: '' } });
  });

  it('leaves an answer to anything else alone', () => {
    const msgs: any[] = [{ role: 'user', text: 'hello' }];
    expect(answerTypedCommand(msgs, 'No response requested.', make)).toBe(false);
    expect(answerTypedCommand([{ role: 'user', text: '/see', images: ['x'] }] as any[], 'x', make)).toBe(false);
    expect(msgs).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('knows a synthetic reply', () => {
    expect(isSyntheticReply({ type: 'assistant', message: { model: '<synthetic>' } })).toBe(true);
    expect(isSyntheticReply({ type: 'assistant', message: { model: 'claude-fable-5-2' } })).toBe(false);
  });
});

describe('absorbCompactSummary', () => {
  const summaryOf = (m: any) => (m.role === 'user' && m.text.startsWith('SUMMARY') ? m.text : null);

  it('takes the summary right before a /compact card', () => {
    const msgs: any[] = [{ role: 'assistant', text: 'hi' }, { role: 'user', text: 'SUMMARY of it' }];
    expect(absorbCompactSummary(msgs, '/compact', summaryOf)).toBe('SUMMARY of it');
    expect(msgs).toEqual([{ role: 'assistant', text: 'hi' }]);
    const withArgs: any[] = [{ role: 'user', text: 'SUMMARY 2' }];
    expect(absorbCompactSummary(withArgs, '/compact keep the plan', summaryOf)).toBe('SUMMARY 2');
  });

  it('leaves other commands and messages alone', () => {
    const msgs: any[] = [{ role: 'user', text: 'SUMMARY of it' }];
    expect(absorbCompactSummary(msgs, '/model opus', summaryOf)).toBeUndefined();
    const prompt: any[] = [{ role: 'user', text: 'a prompt' }];
    expect(absorbCompactSummary(prompt, '/compact', summaryOf)).toBeUndefined();
    expect(prompt).toHaveLength(1);
    expect(absorbCompactSummary([], '/compact', summaryOf)).toBeUndefined();
  });
});

describe('giveSummaryToCompact', () => {
  const make = (command: string) => ({ role: 'localcmd', command }) as any;

  it('turns the typed /compact into a card holding the summary', () => {
    const msgs: any[] = [{ role: 'assistant', text: 'hi' }, { role: 'user', text: '/compact ' }];
    expect(giveSummaryToCompact(msgs, 'S', make)).toBe(true);
    expect(msgs[1]).toEqual({ role: 'localcmd', command: '/compact', summary: 'S' });
    // Its output then lands on the card.
    expect(attachLocalCommandOutput(msgs, { stdout: 'Compacted', stderr: '' })).toBe(true);
    expect(msgs[1].output).toEqual({ stdout: 'Compacted', stderr: '' });
  });

  it('fills a /compact card still without a summary', () => {
    const msgs: any[] = [{ role: 'localcmd', command: '/compact' }];
    expect(giveSummaryToCompact(msgs, 'S', make)).toBe(true);
    expect(msgs[0].summary).toBe('S');
  });

  it('is false otherwise (an automatic compaction)', () => {
    expect(giveSummaryToCompact([{ role: 'user', text: 'hello' }] as any[], 'S', make)).toBe(false);
    expect(giveSummaryToCompact([{ role: 'localcmd', command: '/compact', summary: 'old' }] as any[], 'S', make)).toBe(false);
    expect(giveSummaryToCompact([{ role: 'localcmd', command: '/model opus' }] as any[], 'S', make)).toBe(false);
    expect(giveSummaryToCompact([], 'S', make)).toBe(false);
  });
});

describe('a typed command bubble that turns into a card keeps its id', () => {
  type M = { id: string; role: string; text?: string; command?: string; output?: { stdout: string; stderr: string }; summary?: string };
  let n = 0;
  const card = (command: string, output?: { stdout: string; stderr: string }): M => ({ id: `new${n++}`, role: 'localcmd', command, output });

  it('when the summary arrives (giveSummaryToCompact)', () => {
    const msgs: M[] = [{ id: 'typed', role: 'user', text: '/compact' }];
    expect(giveSummaryToCompact(msgs, 'S', (c) => card(c))).toBe(true);
    expect(msgs[0]).toMatchObject({ id: 'typed', role: 'localcmd', command: '/compact', summary: 'S' });
  });

  it('when its answer arrives (answerTypedCommand)', () => {
    const msgs: M[] = [{ id: 'typed', role: 'user', text: '/cost' }];
    expect(answerTypedCommand(msgs, 'Total: $1', card)).toBe(true);
    expect(msgs[0]).toMatchObject({ id: 'typed', role: 'localcmd', command: '/cost' });
  });

  it('so a refetch right after a compaction does not show the card twice', () => {
    // The ids shown when the refetch began were read before the card replaced the bubble.
    const before = new Set(['a1', 'typed']);
    const msgs: M[] = [{ id: 'a1', role: 'assistant' }, { id: 'typed', role: 'user', text: '/compact' }];
    giveSummaryToCompact(msgs, 'S', (c) => card(c));
    applyLocalCommandOutput(msgs, { stdout: 'Compacted', stderr: '' }, card);
    const fetched: M[] = [{ id: 'f1', role: 'localcmd', command: '/compact', output: { stdout: 'Compacted', stderr: '' } }];
    expect(withArrivedDuring(fetched, msgs, before)).toEqual(fetched);
  });
});
