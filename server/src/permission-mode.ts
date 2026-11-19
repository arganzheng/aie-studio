// Model: Session.mode — how a Claude (SDK) session treats what the agent
// wants to do. The user picks it under the prompt input and may switch at any
// time; it is remembered per session.
//   bypassPermissions  every tool call runs without asking (the default)
//   plan               the agent only looks around and writes a plan; it
//                      hands the plan over (ExitPlanMode) and waits for the
//                      user to approve it before it changes anything

export type SessionMode = 'bypassPermissions' | 'plan';
export const DEFAULT_MODE: SessionMode = 'bypassPermissions';

export function isSessionMode(v: unknown): v is SessionMode {
  return v === 'bypassPermissions' || v === 'plan';
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
