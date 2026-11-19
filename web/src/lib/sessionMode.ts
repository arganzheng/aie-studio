// Model: Session.mode — how a Claude (SDK) session treats what the agent
// wants to do (server/src/permission-mode.ts). Picked under the prompt input,
// switchable at any time.

export type SessionMode = 'bypassPermissions' | 'plan' | 'acceptEdits' | 'auto';

export const MODES: readonly { id: SessionMode; label: string; short: string; description: string }[] = [
  { id: 'bypassPermissions', label: 'Bypass Permissions', short: 'Bypass', description: 'Run every tool call without asking' },
  { id: 'auto', label: 'Auto', short: 'Auto', description: 'Run what Claude judges safe; ask you about the rest' },
  { id: 'acceptEdits', label: 'Accept Edits', short: 'Edits', description: 'Edit files without asking; ask you before other actions such as shell commands' },
  { id: 'plan', label: 'Plan', short: 'Plan', description: 'Plan changes first; nothing is changed until you approve the plan' },
];

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === 'string' && MODES.some((m) => m.id === v);
}

export function modeInfo(mode: SessionMode) {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

// ---- permission requests (model: Session.mode, acceptEdits / auto) ----

// Mirrors server/src/permission-mode.ts PermissionRequest.
export type PermissionRequest = {
  tool: string;
  description?: string;
  reason?: string;
  detail: string;
  detailKind: 'command' | 'json';
  blockedPath?: string;
  canRemember: boolean;
};
export type PermissionAsk = { id: string; request: PermissionRequest };

// Pure: a permission_ask frame as an ask, or null when it is malformed.
export function parsePermissionAsk(m: { id?: unknown; request?: unknown }): PermissionAsk | null {
  const r = m.request as Partial<PermissionRequest> | null | undefined;
  if (typeof m.id !== 'string' || !r || typeof r !== 'object' || typeof r.tool !== 'string') return null;
  return {
    id: m.id,
    request: {
      tool: r.tool,
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
      ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
      detail: typeof r.detail === 'string' ? r.detail : '',
      detailKind: r.detailKind === 'command' ? 'command' : 'json',
      ...(typeof r.blockedPath === 'string' ? { blockedPath: r.blockedPath } : {}),
      canRemember: r.canRemember === true,
    },
  };
}

// Pure: the asks after one more arrived (a re-sent one replaces its old copy).
export function addPermissionAsk(list: readonly PermissionAsk[], ask: PermissionAsk): PermissionAsk[] {
  return [...list.filter((a) => a.id !== ask.id), ask];
}

export function permissionHeadline(r: PermissionRequest): string {
  return r.detailKind === 'command' ? 'Claude wants to run a command' : `Claude wants to use ${r.tool}`;
}
