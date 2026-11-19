// Model: Session.mode — how a Claude (SDK) session treats what the agent
// wants to do (server/src/permission-mode.ts). Picked under the prompt input,
// switchable at any time.

export type SessionMode = 'bypassPermissions' | 'plan';

export const MODES: readonly { id: SessionMode; label: string; short: string; description: string }[] = [
  { id: 'bypassPermissions', label: 'Bypass Permissions', short: 'Bypass', description: 'Run every tool call without asking' },
  { id: 'plan', label: 'Plan', short: 'Plan', description: 'Plan changes first; nothing is changed until you approve the plan' },
];

export function isSessionMode(v: unknown): v is SessionMode {
  return v === 'bypassPermissions' || v === 'plan';
}

export function modeInfo(mode: SessionMode) {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}
