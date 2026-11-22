// Model: web.TerminalPanel helpers.

// 0.5s, 1s, 2s … capped at 10s — same curve as the session panels.
export function terminalReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

// Extra keys for touch devices, whose soft keyboards lack them.
export const TERMINAL_KEYS: ReadonlyArray<{ label: string; seq: string }> = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^L', seq: '\x0c' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];
