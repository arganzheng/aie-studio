// Model: Session.children driven by the parent agent — the wording and limits
// behind the child-session tools the SDK bridge gives a Claude session
// (sdk-session.ts registers the tools; this file is the pure part).
//
// A child session is a full Claude session of its own (own process, own
// conversation), linked to its parent in SessionMeta.parents. The parent
// agent opens one with spawn_child_session, may message it again with
// send_to_child_session, and gets each answer back as a message in its own
// conversation — it never polls.

// Nesting: a session → child → grandchild, no deeper.
export const MAX_CHILD_DEPTH = 2;
// Children of one parent working at the same time.
export const MAX_RUNNING_CHILDREN = 6;
// A child's report is cut to this much of its final answer.
export const MAX_REPORT_CHARS = 20_000;

export const CHILD_REPORT_PREFIX = '[Child session ';

export const CHILD_TOOLS_INSTRUCTIONS = [
  'Child sessions are full Claude sessions the user can open, watch and talk to in the Sessions tree, each with its own context window.',
  'Use spawn_child_session for a substantial, self-contained piece of work that the user may want to follow or steer (a feature slice, a long investigation, work that can run in parallel with yours).',
  'For a quick lookup or a short helper task, prefer the built-in Agent tool: it is cheaper and faster.',
  'A child starts with none of your context: give it a complete brief (goal, relevant files, constraints, what to report back).',
  'spawn_child_session returns at once. When the child finishes, its answer arrives as a message in this conversation starting with "[Child session". Do not wait, sleep or poll for it; carry on with other work or end your turn.',
].join(' ');

// How many ancestors a session has, following SessionMeta.parents (keys
// "claude:<id>"). Stops at a cycle.
export function sessionDepth(parents: Readonly<Record<string, string>>, sessionId: string): number {
  const seen = new Set<string>([sessionId]);
  let depth = 0;
  for (let p = parents[`claude:${sessionId}`]; p && !seen.has(p); p = parents[`claude:${p}`]) {
    seen.add(p);
    depth++;
  }
  return depth;
}

export function childIdsOf(parents: Readonly<Record<string, string>>, sessionId: string): string[] {
  return Object.entries(parents)
    .filter(([k, v]) => v === sessionId && k.startsWith('claude:'))
    .map(([k]) => k.slice('claude:'.length));
}

// Why a spawn is refused, or null when it may go ahead.
export function spawnRefusal(opts: { depth: number; runningChildren: number }): string | null {
  if (opts.depth >= MAX_CHILD_DEPTH) return `Child sessions can be nested at most ${MAX_CHILD_DEPTH} levels deep; this session is already at level ${opts.depth}. Do the work here or use the Agent tool.`;
  if (opts.runningChildren >= MAX_RUNNING_CHILDREN) return `${opts.runningChildren} child sessions of this session are still working (limit ${MAX_RUNNING_CHILDREN}). Wait for one to report back before opening another.`;
  return null;
}

export function cleanChildTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Child session';
}

// The message the parent receives when a child finishes a turn the parent
// asked for. `result` is the child's final answer (SDK result.result).
export function childReport(opts: { title: string; sessionId: string; ok: boolean; result: string; errorKind?: string }): string {
  const head = `${CHILD_REPORT_PREFIX}"${opts.title}" (${opts.sessionId}) ${opts.ok ? 'finished' : `stopped with an error${opts.errorKind ? ` (${opts.errorKind})` : ''}`}]`;
  let body = opts.result.trim();
  if (body.length > MAX_REPORT_CHARS) body = `${body.slice(0, MAX_REPORT_CHARS)}\n… [report cut at ${MAX_REPORT_CHARS} characters; ask the child for the rest with send_to_child_session]`;
  const tail = '(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
  return [head, body || '(the child session gave no final answer)', tail].join('\n\n');
}

// Parse the header of a report (for display). Null when `text` isn't one.
export function parseChildReport(text: string): { title: string; sessionId: string; ok: boolean; body: string } | null {
  const m = /^\[Child session "(.*?)" \(([A-Za-z0-9-]+)\) (finished|stopped with an error[^\]]*)\]\n\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const body = m[4].replace(/\n\n\(Sent automatically by aie-studio[^)]*\)\s*$/, '');
  return { title: m[1], sessionId: m[2], ok: m[3] === 'finished', body };
}
