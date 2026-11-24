import { isPlanTool, type PlanItem } from './plan';
import { toolLine } from './workGroups';

// Model: web.LiveActivity — the one line at the foot of the chat while Claude
// works (like Devin's "Tracing generated autograd dispatch paths"): the step
// of its task list in progress, in its present-tense form; without one, the
// last tool call of this turn, read the way a work-group row reads it.

type Item =
  | { role: 'user' }
  | { role: 'tool'; name: string; input: any; output?: string }
  | { role: string };

export function liveActivity(plan: ReadonlyArray<PlanItem> | null | undefined, msgs: ReadonlyArray<Item>, rel: (s: string) => string = (s) => s): string {
  const step = plan?.find((p) => p.status === 'in_progress');
  if (step) return (step.active || step.text).trim();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') break;
    if (m.role !== 'tool') continue;
    const t = m as Extract<Item, { role: 'tool' }>;
    if (isPlanTool(t.name)) continue;
    const line = toolLine(t.name, t.input, rel, t.output === undefined);
    // A command's description already reads as a sentence ("Run web tests").
    if (t.name === 'Bash' && line.desc) return line.desc;
    return [line.verb, line.desc || line.detail].filter(Boolean).join(' ');
  }
  return 'Thinking';
}
