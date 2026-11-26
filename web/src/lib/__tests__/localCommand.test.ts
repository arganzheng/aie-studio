import { describe, expect, it } from 'vitest';
import { answerTypedCommand, applyLocalCommandOutput, attachLocalCommandOutput, isSyntheticReply, localCommandOutputOf, localCommandText, localCommandView, splitLocalCommandTexts } from '../localCommand';

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

  it('leaves /compact to compactNote', () => {
    const cmd = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>';
    const out = '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>';
    expect(splitLocalCommandTexts([cmd, out])).toEqual([{ kind: 'text', text: cmd }, { kind: 'text', text: out }]);
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

  it('ignores other records and compaction', () => {
    expect(localCommandOutputOf({ type: 'system', subtype: 'init' })).toBeNull();
    expect(localCommandOutputOf({ type: 'user', message: { content: 'x' } })).toBeNull();
    expect(localCommandOutputOf({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Compacted (ctrl+o)</local-command-stdout>' })).toBeNull();
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
