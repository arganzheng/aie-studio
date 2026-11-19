// Model: Session.mode — how a Claude (SDK) session treats what the agent
// wants to do. The user picks it under the prompt input and may switch at any
// time; it is remembered per session.
//   bypassPermissions  every tool call runs without asking (the default)
//   plan               the agent only looks around and writes a plan; it
//                      hands the plan over (ExitPlanMode) and waits for the
//                      user to approve it before it changes anything
//   acceptEdits        file edits run without asking; anything else the CLI
//                      wants a human for (most shell commands) is put to
//                      the user as a permission request
//   auto               the CLI's own classifier approves what it judges
//                      safe; the rest is put to the user the same way

export const SESSION_MODES = ['bypassPermissions', 'plan', 'acceptEdits', 'auto'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];
export const DEFAULT_MODE: SessionMode = 'bypassPermissions';

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === 'string' && (SESSION_MODES as readonly string[]).includes(v);
}

// The tool the agent calls to hand its plan over.
export const PLAN_TOOL = 'ExitPlanMode';

// Pure: the plan text of an ExitPlanMode call.
export function planOf(input: unknown): string {
  const p = (input as { plan?: unknown } | null)?.plan;
  return typeof p === 'string' ? p.trim() : '';
}

export const PLAN_FEEDBACK_MAX = 4000;

// Pure: what the agent is told when the user sends the plan back.
export function planRejection(feedback: unknown): string {
  const f = typeof feedback === 'string' ? feedback.trim().slice(0, PLAN_FEEDBACK_MAX) : '';
  return f
    ? `The user did not approve the plan and asks for changes:\n\n${f}\n\nStay in plan mode: revise the plan and present it again.`
    : 'The user did not approve the plan. Stay in plan mode, stop here and wait for their next message.';
}

// What a tool call that needs permission gets while the session is in plan
// mode: nothing may change before the plan is approved.
export const PLAN_MODE_DENIAL = 'This session is in plan mode: nothing may be changed yet. Finish the plan and present it with ExitPlanMode; the user will approve it or ask for changes.';

// ---- permission requests (acceptEdits / auto) ----

// The app's own tools (child sessions) never need the user's say-so.
export function isOwnTool(toolName: string): boolean {
  return toolName.startsWith('mcp__aie__') || toolName.startsWith('mcp__aie_status__');
}

export const PERMISSION_INPUT_MAX = 6000;

// What a client is shown for one tool call waiting on the user.
export type PermissionRequest = {
  tool: string;
  // One line of what the call is for, when the agent gave one.
  description?: string;
  // Why the CLI wants a human for it.
  reason?: string;
  // Bash: the command. Other tools: their input as JSON, cut when long.
  detail: string;
  detailKind: 'command' | 'json';
  // The path the CLI says is off limits, if that is why it asks.
  blockedPath?: string;
  // "Allow for this session" is on offer: the CLI suggested a rule.
  canRemember: boolean;
};

// Pure: the request as the user sees it.
export function describePermission(
  toolName: string,
  input: Record<string, unknown>,
  opts: { description?: string; decisionReason?: string; blockedPath?: string; suggestions?: readonly unknown[] } = {},
): PermissionRequest {
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : null;
  let detail = command ?? '';
  if (command === null) { try { detail = JSON.stringify(input, null, 2) ?? ''; } catch { detail = ''; } }
  if (detail.length > PERMISSION_INPUT_MAX) detail = `${detail.slice(0, PERMISSION_INPUT_MAX)}\n… [cut]`;
  const description = opts.description ?? (typeof input.description === 'string' ? input.description : undefined);
  return {
    tool: toolName,
    ...(description ? { description: description.slice(0, 300) } : {}),
    ...(opts.decisionReason ? { reason: opts.decisionReason.slice(0, 300) } : {}),
    detail,
    detailKind: command === null ? 'json' : 'command',
    ...(opts.blockedPath ? { blockedPath: opts.blockedPath } : {}),
    canRemember: Array.isArray(opts.suggestions) && opts.suggestions.length > 0,
  };
}

// Pure: the CLI's suggested rules, re-aimed at this session only — the user
// said "for this session", so nothing is written to a settings file.
export function sessionRules<T extends { destination?: string }>(suggestions: readonly T[] | undefined): T[] {
  return (suggestions ?? []).map((s) => ({ ...s, destination: 'session' }));
}

export function permissionDenial(note: unknown): string {
  const n = typeof note === 'string' ? note.trim().slice(0, PLAN_FEEDBACK_MAX) : '';
  return n ? `The user did not allow this action: ${n}` : 'The user did not allow this action. Do not retry it; go on without it or stop and ask what they want instead.';
}

// One line for the notification.
export function permissionSummary(r: PermissionRequest): string {
  const what = r.description || (r.detailKind === 'command' ? r.detail.split('\n')[0] : '');
  return `Allow ${r.tool}${what ? `: ${what.slice(0, 120)}` : ''}?`;
}
