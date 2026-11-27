import { describe, expect, it } from 'vitest';
import { modelSwitchLabel, pickerSwitchCard, settlePickerSwitch } from '../modelSwitch';
import { attachLocalCommandOutput } from '../localCommand';

describe('picker switch card', () => {
  it('takes Claude Code\'s own output for the switch', () => {
    const msgs: any[] = [{ role: 'localcmd', command: '/compact' }, { id: 'c', ...pickerSwitchCard('opus') }];
    expect(attachLocalCommandOutput(msgs, { stdout: 'Set model to `opus (claude-opus-5-5)`', stderr: '' })).toBe(true);
    expect(msgs[1].output.stdout).toContain('Set model to');
    expect(msgs[0].output).toBeUndefined();
  });

  it('lets other outputs pass it by (a compaction ending meanwhile)', () => {
    const msgs: any[] = [{ role: 'localcmd', command: '/compact' }, { id: 'c', ...pickerSwitchCard('opus') }];
    expect(attachLocalCommandOutput(msgs, { stdout: 'Compacted', stderr: '' })).toBe(true);
    expect(msgs[0].output).toEqual({ stdout: 'Compacted', stderr: '' });
    expect(msgs[1].output).toBeUndefined();
  });

  it('is settled by the server\'s answer when nothing else filled it', () => {
    const msgs: any[] = [{ id: 'c', ...pickerSwitchCard('opus') }];
    const next = settlePickerSwitch(msgs, 'opus', { stdout: '', stderr: "Couldn't switch: nope" });
    expect(next[0].output.stderr).toBe("Couldn't switch: nope");
    expect(settlePickerSwitch(next, 'opus', { stdout: 'x', stderr: '' })).toBe(next);
    expect(settlePickerSwitch(msgs, 'sonnet', { stdout: 'x', stderr: '' })).toBe(msgs);
  });
});

describe('modelSwitchLabel', () => {
  it('says so while waiting', () => {
    expect(modelSwitchLabel('opus')).toBe('Switching to opus…');
    expect(modelSwitchLabel(null)).toBeNull();
  });
});
