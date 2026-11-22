// Model: web.WorkGroups — the conversation as the user reads it: what is
// meant for them (their messages, Claude's messages, cards that want
// something from them) and, in between, the work Claude did, folded into
// one group per stretch ("Worked for 2m 7s +303 −13").
//
// Where a group ends (rule Y, picked with the user after comparing Devin):
// at anything meant for the user. Claude's own words in the middle of the
// work ("Next, the server side:", "Tests pass; now the screenshots") stay
// inside the group as notes; a message of Claude's breaks it only when it
// asks the user something, is a structured report (list, table, heading or
// long), or is the last thing of the turn.
//
// Inside a group (second level, as Devin does): ordinary calls made together
// in one model response fold into "Ran N tool calls"; a call made on its
// own is its own row ("Ran <what for> <command>"), as are edits, task
// changes, thoughts and notes.

export type WorkMsg =
  | { id: string; role: 'user' | 'system' | 'bang' }
  | { id: string; role: 'assistant'; text: string; at?: number }
  | { id: string; role: 'thinking'; text: string; at?: number; ms?: number }
  | { id: string; role: 'tool'; name: string; input: any; output?: string; at?: number; doneAt?: number; step?: string };

type Tool = Extract<WorkMsg, { role: 'tool' }>;
type Thought = Extract<WorkMsg, { role: 'thinking' }>;
type Note = Extract<WorkMsg, { role: 'assistant' }>;

export type WorkRow =
  | { kind: 'tool'; tool: Tool }
  | { kind: 'batch'; tools: Tool[] }
  | { kind: 'edit'; tool: Tool; add: number; del: number }
  | { kind: 'task'; tool: Tool; label: string }
  | { kind: 'thought'; thoughts: Thought[]; ms: number | null }
  | { kind: 'note'; note: Note };

export type WorkGroup = {
  kind: 'group';
  id: string;
  rows: WorkRow[];
  msgs: WorkMsg[];
  start: number | null;
  end: number | null;
  add: number;
  del: number;
  steps: number;
  // Only thinking in it: the header reads "Thought for Ns".
  thoughtOnly: boolean;
  // The work still going on (the last group while Claude works).
  running: boolean;
};

export type WorkItem<M extends WorkMsg> = { kind: 'msg'; msg: M } | WorkGroup;

// Tools that want the user (a question form, a plan to approve): shown as
// they are, never folded away.
const CARD_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
export const BATCH_MIN = 2;
const LONG_MESSAGE = 400;

// A message of Claude's that is a report rather than a step: a list, a
// table, a heading, or long.
export function isStructured(text: string): boolean {
  return text.length > LONG_MESSAGE || /(^|\n)\s*(#{1,4} |[-*] |\d+\. |\|)/.test(text);
}

// A message of Claude's that waits for the user.
export function asksUser(text: string): boolean {
  const t = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  return /[?？]$/.test(t) || /<!--status needs-you/.test(text);
}

export function isCardTool(name: string): boolean { return CARD_TOOLS.has(name); }

function lines(s: unknown): string[] {
  return typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n') : [];
}

// Lines added / removed by one change, counted as Devin does: what is not
// common to both sides (multiset), not a real diff.
export function changeCounts(oldText: unknown, newText: unknown): { add: number; del: number } {
  const a = lines(oldText);
  const b = lines(newText);
  const left = new Map<string, number>();
  for (const l of a) left.set(l, (left.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const n = left.get(l) ?? 0;
    if (n > 0) { common++; left.set(l, n - 1); }
  }
  return { add: b.length - common, del: a.length - common };
}

// What an Edit / MultiEdit / Write changed, in lines.
export function editCounts(name: string, input: any): { add: number; del: number } {
  if (!input || typeof input !== 'object') return { add: 0, del: 0 };
  if (name === 'Write') return { add: lines(input.content).length, del: 0 };
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.reduce((acc: { add: number; del: number }, e: any) => {
      const c = changeCounts(e?.old_string, e?.new_string);
      return { add: acc.add + c.add, del: acc.del + c.del };
    }, { add: 0, del: 0 });
  }
  return changeCounts(input.old_string, input.new_string);
}

// A failed call: the CLI wraps the refusal / error it reports to the model.
export function toolFailed(t: { output?: string }): boolean {
  return typeof t.output === 'string' && t.output.startsWith('<tool_use_error>');
}

// "Created task X", "Started task X", "Completed task X", "Updated the plan".
function taskLabel(t: Tool, subjects: Map<string, string>): string {
  const i = t.input ?? {};
  if (t.name === 'TodoWrite') return Array.isArray(i.todos) ? `Updated the plan (${i.todos.length} items)` : 'Updated the plan';
  if (t.name === 'TaskCreate') {
    const id = /Task #(\d+)/.exec(t.output ?? '')?.[1];
    if (id && typeof i.subject === 'string') subjects.set(id, i.subject);
    return `Created task ${i.subject ?? ''}`.trim();
  }
  const subject = (typeof i.subject === 'string' && i.subject) || subjects.get(String(i.taskId)) || `#${i.taskId ?? '?'}`;
  if (typeof i.subject === 'string' && i.taskId != null) subjects.set(String(i.taskId), i.subject);
  const verb = i.status === 'in_progress' ? 'Started task' : i.status === 'completed' ? 'Completed task' : i.status === 'deleted' ? 'Removed task' : 'Updated task';
  return `${verb} ${subject}`;
}

// Is this assistant text meant for the user (it breaks the work into
// groups), or a note inside the work? `final`: nothing but text and thinking
// follows it in its turn.
function isMessage(text: string, final: boolean): boolean {
  return final || asksUser(text) || isStructured(text);
}

export function groupWork<M extends WorkMsg>(msgs: readonly M[], working: boolean): WorkItem<M>[] {
  // For each assistant text: does a tool call follow before the turn ends?
  const followedByTool = new Array<boolean>(msgs.length).fill(false);
  let toolAhead = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'tool') toolAhead = !isCardTool(m.name);
    else if (m.role !== 'assistant' && m.role !== 'thinking') toolAhead = false;
    followedByTool[i] = toolAhead;
  }

  const out: WorkItem<M>[] = [];
  const subjects = new Map<string, string>();
  let cur: M[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    out.push(buildGroup(cur, subjects));
    cur = [];
  };
  msgs.forEach((m, i) => {
    const visible =
      m.role === 'user' || m.role === 'system' || m.role === 'bang'
      || (m.role === 'tool' && isCardTool(m.name))
      || (m.role === 'assistant' && isMessage(m.text, !followedByTool[i]));
    if (visible) { flush(); out.push({ kind: 'msg', msg: m }); }
    else cur.push(m);
  });
  flush();
  // While Claude works, the work since the last thing shown is going on.
  if (working) {
    const last = out[out.length - 1];
    if (last?.kind === 'group') last.running = true;
  }
  return out;
}

function buildGroup(msgs: WorkMsg[], subjects: Map<string, string>): WorkGroup {
  const rows: WorkRow[] = [];
  let plain: Tool[] = [];
  let thoughts: Thought[] = [];
  let thoughtMs = 0;
  let thoughtMsKnown = false;
  let prevEnd: number | null = null;
  let add = 0;
  let del = 0;
  let steps = 0;
  // plain: ordinary calls of one model response (same step).
  const flushPlain = () => {
    if (plain.length >= BATCH_MIN) rows.push({ kind: 'batch', tools: plain });
    else for (const t of plain) rows.push({ kind: 'tool', tool: t });
    plain = [];
  };
  const flushThoughts = () => {
    if (thoughts.length) rows.push({ kind: 'thought', thoughts, ms: thoughtMsKnown ? thoughtMs : null });
    thoughts = []; thoughtMs = 0; thoughtMsKnown = false;
  };
  let start: number | null = null;
  let end: number | null = null;
  for (const m of msgs) {
    const at = 'at' in m ? m.at ?? null : null;
    const done = m.role === 'tool' ? m.doneAt ?? at : at;
    if (at != null && (start == null || at < start)) start = at;
    if (done != null && (end == null || done > end)) end = done;
    if (m.role === 'thinking') {
      flushPlain();
      thoughts.push(m);
      // Live: measured. From a transcript: the record is written when the
      // thinking ends, so it took the time since the previous step ended.
      const ms = m.ms ?? (m.at != null && prevEnd != null ? Math.max(0, m.at - prevEnd) : null);
      if (ms != null) { thoughtMs += ms; thoughtMsKnown = true; }
    } else if (m.role === 'assistant') {
      flushPlain(); flushThoughts();
      rows.push({ kind: 'note', note: m });
    } else if (m.role === 'tool') {
      flushThoughts();
      steps++;
      if (EDIT_TOOLS.has(m.name)) {
        flushPlain();
        const c = editCounts(m.name, m.input);
        if (!toolFailed(m)) { add += c.add; del += c.del; }
        rows.push({ kind: 'edit', tool: m, ...c });
      } else if (TASK_TOOLS.has(m.name)) {
        flushPlain();
        rows.push({ kind: 'task', tool: m, label: taskLabel(m, subjects) });
      } else {
        if (plain.length && (m.step == null || plain[0].step !== m.step)) flushPlain();
        plain.push(m);
      }
    }
    if (done != null) prevEnd = done;
  }
  flushPlain(); flushThoughts();
  return {
    kind: 'group',
    id: msgs[0].id,
    rows,
    msgs,
    start,
    end,
    add,
    del,
    steps,
    thoughtOnly: msgs.every((m) => m.role === 'thinking'),
    running: false,
  };
}

// "39s", "2m 7s", "1h 3m".
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One call as a row: a verb, what it was for (Claude's description, a path,
// a pattern), and the command or argument behind it in light type.
export function toolLine(name: string, input: any, rel: (s: string) => string, running: boolean): { verb: string; desc: string; detail: string } {
  const i = input && typeof input === 'object' ? input : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const one = (v: string) => rel(v).replace(/\s+/g, ' ').trim();
  switch (name) {
    case 'Bash': return { verb: running ? 'Running' : 'Ran', desc: one(str(i.description)), detail: one(str(i.command)) };
    case 'Read': {
      const from = typeof i.offset === 'number' ? i.offset : null;
      const to = from != null && typeof i.limit === 'number' ? from + i.limit - 1 : null;
      return { verb: 'Read', desc: one(str(i.file_path)), detail: from != null ? (to != null ? `lines ${from}–${to}` : `from line ${from}`) : '' };
    }
    case 'Edit': case 'MultiEdit': return { verb: 'Edited', desc: one(str(i.file_path)), detail: '' };
    case 'Write': return { verb: 'Wrote', desc: one(str(i.file_path)), detail: '' };
    case 'NotebookEdit': return { verb: 'Edited', desc: one(str(i.notebook_path)), detail: '' };
    case 'Grep': return { verb: 'Searched', desc: one(str(i.pattern)), detail: one([str(i.path), str(i.glob)].filter(Boolean).join(' ')) };
    case 'Glob': return { verb: 'Listed', desc: one(str(i.pattern)), detail: one(str(i.path)) };
    case 'WebFetch': return { verb: 'Fetched', desc: one(str(i.url)), detail: '' };
    case 'WebSearch': return { verb: 'Searched the web', desc: one(str(i.query)), detail: '' };
    case 'Agent': case 'Task': return { verb: 'Agent', desc: one(str(i.description)), detail: one(str(i.subagent_type)) };
    case 'ToolSearch': return { verb: 'Loaded tools', desc: one(str(i.query)).replace(/^select:/, ''), detail: '' };
    case 'Skill': return { verb: 'Skill', desc: one(str(i.skill)), detail: one(str(i.args)) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const arg = str(i.description) || str(i.command) || str(i.query) || str(i.prompt) || str(i.title) || str(i.kind) || '';
    return { verb: 'Called', desc: `${mcp[2].replace(/_/g, ' ')}`, detail: one(arg ? `${mcp[1]} · ${arg}` : mcp[1]) };
  }
  const arg = str(i.description) || str(i.command) || str(i.file_path) || str(i.path) || str(i.pattern) || str(i.query) || str(i.url) || str(i.prompt);
  return { verb: name, desc: one(arg), detail: '' };
}

// "Ran 6 tool calls", "Read 4 files".
export function batchLabel(tools: ReadonlyArray<{ name: string }>): string {
  const n = tools.length;
  if (tools.every((t) => t.name === 'Read')) return `Read ${n} files`;
  if (tools.every((t) => t.name === 'Read' || t.name === 'Grep' || t.name === 'Glob')) return `Explored ${n} files and searches`;
  return `Ran ${n} tool calls`;
}
