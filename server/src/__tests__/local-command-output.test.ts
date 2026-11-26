import { describe, expect, it } from 'vitest';
import { localCommandOutputs } from '../local-command-output.js';

describe('localCommandOutputs', () => {
  it('maps a command record to its output', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'system', subtype: 'local_command', uuid: 's1', parentUuid: 'c1', content: '<local-command-stdout>Set model</local-command-stdout>' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 's2', parentUuid: 'c1', content: 'x' }),
      'not json "local_command"',
      JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'what is "local_command"?' } }),
    ].join('\n');
    expect([...localCommandOutputs(jsonl)]).toEqual([['c1', '<local-command-stdout>Set model</local-command-stdout>']]);
  });

  it('is empty for a transcript without commands', () => {
    expect(localCommandOutputs('').size).toBe(0);
  });
});
