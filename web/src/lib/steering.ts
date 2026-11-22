// Model: Session.queue — writing to Claude while it works.

// A slash command (`/compact`, `/plugin:cmd arg`), as opposed to text that
// starts with a path (`/tmp/x is wrong`). Written during a turn, the CLI runs
// it only once the turn has ended. Same rule as the server's
// steersRunningTurn.
export function isSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z][\w:-]*(\s|$)/.test(text);
}

export function isCompactCommand(text: string): boolean {
  return /^\s*\/compact(\s|$)/.test(text);
}

// What the CLI writes into the conversation when the user stops a turn
// ("[Request interrupted by user]", "… for tool use]"): a note, not something
// the user typed.
export function isInterruptNote(text: string): boolean {
  return /^\[Request interrupted by user[^\]]*\]\s*$/.test(text.trim());
}
