import { describe, expect, it } from 'vitest';
import { parseTaskNotifications, quietTaskNotes, taskNoteFailed } from '../taskNotification';
import { groupWork, type WorkMsg } from '../workGroups';

const done = `<task-notification>
<task-id>b5borjlx8</task-id>
<tool-use-id>toolu_01</tool-use-id>
<output-file>/tmp/tasks/b5borjlx8.output</output-file>
<status>completed</status>
<summary>Background command "npm run serve &gt; log 2&gt;&amp;1" completed (exit code 0)</summary>
</task-notification>`;

const agentDone = `<task-notification>
<task-id>a43e958f9d529c877</task-id>
<status>completed</status>
<summary>Agent "Review the series" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result># Review

- point one</result>
</task-notification>`;

const cutOff = `<task-notification>
<task-id>a52ae9532eeb1e81e</task-id>
<output-file>/tmp/tasks/a52ae9532eeb1e81e.output</output-file>
<status>stopped</status>
<summary>Background agent "Check ranges" didn't finish before the previous session ended</summary>
<note>No completion record was found for it.</note>
</task-notification>`;

const orphans = `<task-notification>
<task-id>b13qwu60g</task-id>
<task-id>bmbn6xc2z</task-id>
<task-id>__orphan_summary__:shell</task-id>
<status>stopped</status>
<summary>2 background shell command tasks didn't finish before the previous session ended.</summary>
</task-notification>`;

describe('parseTaskNotifications', () => {
  it('reads a finished command, decoding entities', () => {
    expect(parseTaskNotifications(done)).toEqual([{
      ids: ['b5borjlx8'], status: 'completed', outputFile: '/tmp/tasks/b5borjlx8.output',
      summary: 'Background command "npm run serve > log 2>&1" completed (exit code 0)', note: undefined, result: undefined,
    }]);
  });
  it("keeps an agent's report", () => {
    expect(parseTaskNotifications(agentDone)?.[0].result).toBe('# Review\n\n- point one');
  });
  it('reads several in one message and drops scan markers', () => {
    const n = parseTaskNotifications(`${cutOff}\n${orphans}`);
    expect(n?.map((x) => x.ids)).toEqual([['a52ae9532eeb1e81e'], ['b13qwu60g', 'bmbn6xc2z']]);
    expect(n?.every(taskNoteFailed)).toBe(true);
  });
  it('is not one when the user wrote something too, or nothing of it', () => {
    expect(parseTaskNotifications(`${done}\nalso fix the bug`)).toBeNull();
    expect(parseTaskNotifications('what is a <task-notification>?')).toBeNull();
    expect(parseTaskNotifications(undefined)).toBeNull();
  });
  it('quiet: only when every task got to its end', () => {
    expect(quietTaskNotes(done)).not.toBeNull();
    expect(quietTaskNotes(done.replace('completed</status>', 'killed</status>'))).not.toBeNull();
    expect(quietTaskNotes(done.replace('completed</status>', 'failed</status>'))).toBeNull();
    expect(quietTaskNotes(`${done}${cutOff}`)).toBeNull();
  });
});

describe('groupWork with task notifications', () => {
  const tool = (id: string, step: string): WorkMsg => ({ id, role: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'ok', step });
  it('a finished task is a row of the work, not a break', () => {
    const msgs: WorkMsg[] = [
      { id: 'u', role: 'user', text: 'go' },
      tool('t1', 's1'),
      { id: 'n', role: 'user', text: done },
      tool('t2', 's2'),
      { id: 'a', role: 'assistant', text: 'Done.' },
    ];
    const items = groupWork(msgs, false);
    expect(items.map((i) => (i.kind === 'group' ? `group:${i.rows.map((r) => r.kind).join(',')}` : i.msg.id))).toEqual(['u', 'group:tool,notice,tool', 'a']);
  });
  it('one cut off is shown on its own', () => {
    const items = groupWork([{ id: 'a', role: 'assistant', text: 'Done.' }, { id: 'n', role: 'user', text: cutOff }] as WorkMsg[], false);
    expect(items.map((i) => (i.kind === 'msg' ? i.msg.id : 'group'))).toEqual(['a', 'n']);
  });
});
