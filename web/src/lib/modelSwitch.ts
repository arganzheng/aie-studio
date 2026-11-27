// Model: a model switch made from the picker. The card for it ("/model X")
// shows at once; the output Claude Code prints for the switch ("Set model to
// …", also recorded in the transcript, so a reload shows the same card)
// lands on it. The status bar waits for the server's answer
// (model_switched / model_switch_failed).

export type PickerSwitchCard = { role: 'localcmd'; command: string; picker: true };

export function pickerSwitchCard(model: string): PickerSwitchCard {
  return { role: 'localcmd', command: `/model ${model}`, picker: true };
}

// Fills the latest picker card for `model` still without an output (in a
// copy); the same array when there is none.
export function settlePickerSwitch<M extends { role: string }>(msgs: M[], model: string, output: { stdout: string; stderr: string }): M[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as M & { command?: string; picker?: boolean; output?: unknown };
    if (m.role !== 'localcmd' || !m.picker || m.command !== `/model ${model}` || m.output) continue;
    const next = [...msgs];
    next[i] = { ...m, output };
    return next;
  }
  return msgs;
}

// The status bar while a switch waits for its answer.
export function modelSwitchLabel(pending: string | null): string | null {
  return pending ? `Switching to ${pending}…` : null;
}
