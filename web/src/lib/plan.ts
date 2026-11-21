// Model: web.PlanStrip — the agent's current task list, pinned above the chat.
//
// Claude keeps it with one of two tool families:
//   TodoWrite {todos: [{content, status, activeForm}]}  — every call is the whole list
//   TaskCreate {subject, activeForm?} / TaskUpdate {taskId, status?, subject?, …}
//                                                        — one task at a time
// Devin sends ACP `plan` updates ({entries: [{content, status}]}), each the
// whole list. Either way the strip shows the state after the last call.

export type PlanStatus = 'pending' | 'in_progress' | 'completed';
// id: TaskCreate's task id; absent for whole-list sources.
// active: the present-tense form shown while the item is in progress.
export type PlanItem = { id?: string; text: string; active?: string; status: PlanStatus };
// One plan tool call as seen in a transcript. output: the tool result text,
// where TaskCreate reports the id it gave the task.
export type PlanToolCall = { name: string; input: any; output?: string };

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
export function isPlanTool(name: string): boolean { return PLAN_TOOLS.has(name); }

function status(s: unknown): PlanStatus {
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}
function str(s: unknown): string | undefined {
  return typeof s === 'string' && s.trim() ? s : undefined;
}

// A whole-list source (TodoWrite input or a Devin plan) → items; null when it
// isn't one.
export function planFromList(list: unknown): PlanItem[] | null {
  if (!Array.isArray(list)) return null;
  const out: PlanItem[] = [];
  for (const t of list) {
    const text = str(t?.content);
    if (text) out.push({ text, active: str(t?.activeForm), status: status(t?.status) });
  }
  return out;
}

// The plan after `calls`, in order, on top of `start`. null = no plan tool
// has run yet; [] = the agent cleared its list. Both hide the strip.
export function foldPlan(calls: Iterable<PlanToolCall>, start: PlanItem[] | null = null): PlanItem[] | null {
  let plan = start;
  // TaskCreate numbers tasks 1, 2, 3 … ; used when its result hasn't arrived.
  let nextId = 1;
  for (const c of calls) {
    if (c.name === 'TodoWrite') {
      const list = planFromList(c.input?.todos);
      if (list) plan = list;
    } else if (c.name === 'TaskCreate') {
      const text = str(c.input?.subject);
      if (!text) continue;
      const m = typeof c.output === 'string' ? /#(\d+)/.exec(c.output) : null;
      const id = m ? m[1] : String(nextId);
      nextId = Math.max(nextId, Number(id) + 1);
      plan = [...(plan ?? []).filter((x) => x.id !== id), { id, text, active: str(c.input?.activeForm), status: 'pending' }];
    } else if (c.name === 'TaskUpdate') {
      const id = c.input?.taskId != null ? String(c.input.taskId) : '';
      if (!plan || !id) continue;
      const u = c.input;
      plan = u.status === 'deleted'
        ? plan.filter((x) => x.id !== id)
        : plan.map((x) => x.id !== id ? x : {
            ...x,
            text: str(u.subject) ?? x.text,
            active: str(u.activeForm) ?? x.active,
            status: u.status !== undefined ? status(u.status) : x.status,
          });
    }
  }
  return plan;
}

// The one-line head of the strip: progress and what is happening now (the
// item in progress, else the next one waiting).
export function planSummary(plan: readonly PlanItem[]): { done: number; total: number; current: PlanItem | null } {
  const done = plan.filter((x) => x.status === 'completed').length;
  const current = plan.find((x) => x.status === 'in_progress') ?? plan.find((x) => x.status === 'pending') ?? null;
  return { done, total: plan.length, current };
}
