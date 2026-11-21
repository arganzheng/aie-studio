// Model: web.PlanStrip — a chat tab loads only the tail of a transcript, but
// the agent's task list may have been written long before it. The transcript
// routes therefore also hand back the plan tool calls (TodoWrite / TaskCreate /
// TaskUpdate) from the part the tab did not load; the page folds them with the
// ones it did (web/src/lib/plan.ts).

export type PlanToolCall = { name: string; input: unknown; output?: string };

const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);

function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text);
  return parts.length ? parts.join('\n') : undefined;
}

// Pure: the plan tool calls in `msgs` (transcript records with a
// `message.content` block list), in order, each with its result text. A
// TodoWrite rewrites the whole list, so nothing before the last one matters.
export function planToolCalls(msgs: readonly { message?: unknown }[]): PlanToolCall[] {
  const calls: PlanToolCall[] = [];
  const byId = new Map<string, PlanToolCall>();
  for (const m of msgs) {
    const content = (m?.message as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && PLAN_TOOLS.has(b.name)) {
        const call: PlanToolCall = { name: b.name, input: b.input };
        if (b.name === 'TodoWrite') { calls.length = 0; byId.clear(); }
        calls.push(call);
        if (typeof b.id === 'string') byId.set(b.id, call);
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const call = byId.get(b.tool_use_id);
        if (call) call.output = resultText(b.content);
      }
    }
  }
  return calls;
}
