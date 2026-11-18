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
  'A child starts with none of your context. Put what it must know about the wider work in `background` (the goal, decisions already made and why, constraints and preferences the user stated, relevant files) and the job itself in `prompt` (what to do and what to report back).',
  'When a child will edit files while you or other children are editing too, open it with isolation "worktree": it then works on its own branch in its own checkout, and its report says which branch to merge. For read-only work (investigation, review) leave isolation out.',
  'If a child goes the wrong way or is no longer needed, stop_child_session interrupts it.',
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

// An SDK `result` that closes a turn the model actually ran. Resuming a
// session whose background task died with its old process yields a
// bookkeeping result first (num_turns 0, no text): that is not the answer
// to anything, and reporting it would swallow the real one.
export function isTurnResult(result: any): boolean {
  if (result?.num_turns === 0 && !(typeof result?.result === 'string' && result.result.trim())) return false;
  return true;
}

// The first message of a child the parent's agent opens: where it stands,
// what the parent knows, and the job.
export function childBrief(o: { parentTitle: string; parentId: string; background: string; prompt: string; worktree?: string }): string {
  const background = o.background.trim();
  return [
    `You are a child session of "${o.parentTitle}" (session ${o.parentId}) in aie-studio. That parent session's agent opened you for the task below. When you finish, your final answer is sent to it automatically, so end with a clear report of what you did and found. The user can see this session and may message you directly; follow what they say.`,
    ...(o.worktree ? [o.worktree] : []),
    ...(background && !/^(none|n\/a)\.?$/i.test(background) ? [`Background from the parent session:\n${background}`] : []),
    `Your task:\n${o.prompt.trim()}`,
  ].join('\n\n');
}

// What a child opened in its own worktree is told ahead of its brief.
export function worktreePreface(o: { path: string; branch: string; projectPath: string }): string {
  return [
    `You are working in your own git worktree at ${o.path}, on branch ${o.branch}. It was created for this task from the latest commit; uncommitted changes of the main checkout are not in it.`,
    `Make all your changes here and commit them on ${o.branch} before you finish. Do not switch branches, and do not modify the main checkout at ${o.projectPath}.`,
    'If you need dependencies that are not installed in this worktree (for example node_modules), install them here.',
  ].join(' ');
}

export function cleanChildTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Child session';
}

// The message the parent receives when a child finishes a turn the parent
// asked for. `result` is the child's final answer (SDK result.result).
// `userNotes`: what the user typed into the child directly during the turn
// (an intervention the parent did not see) — quoted ahead of the answer so
// the parent can adjust its plan.
// `stopped`: the turn did not end by itself — the user stopped the child,
// its parent did (stop_child_session), or the server went down under it.
export type ChildStop = 'user' | 'parent' | 'restart';
const STOP_STATE: Record<ChildStop, string> = {
  user: 'was stopped by the user',
  parent: 'was stopped by its parent session',
  restart: 'was interrupted by an aie-studio restart',
};
// `worktreeNote`: where the child's file changes are, when it worked in its
// own git worktree (worktrees.ts worktreeNote).
export function childReport(opts: { title: string; sessionId: string; ok: boolean; result: string; errorKind?: string; userNotes?: readonly string[]; stopped?: ChildStop; worktreeNote?: string }): string {
  const notes = (opts.userNotes ?? []).map((n) => n.trim()).filter(Boolean);
  const state = opts.stopped
    ? STOP_STATE[opts.stopped]
    : opts.ok
      ? (notes.length > 0 ? 'finished after the user stepped in' : 'finished')
      : `stopped with an error${opts.errorKind ? ` (${opts.errorKind})` : ''}`;
  const head = `${CHILD_REPORT_PREFIX}"${opts.title}" (${opts.sessionId}) ${state}]`;
  let body = opts.result.trim();
  if (body.length > MAX_REPORT_CHARS) body = `${body.slice(0, MAX_REPORT_CHARS)}\n… [report cut at ${MAX_REPORT_CHARS} characters; ask the child for the rest with send_to_child_session]`;
  const tail = '(Sent automatically by aie-studio when the child session finished; not typed by the user.)';
  const answer = body || (opts.stopped
    ? `(no final answer: the child session ${STOP_STATE[opts.stopped]} before it finished${opts.stopped === 'parent' ? '' : '; use send_to_child_session to have it continue'})`
    : '(the child session gave no final answer)');
  const wt = opts.worktreeNote ? [opts.worktreeNote] : [];
  if (notes.length === 0) return [head, answer, ...wt, tail].join('\n\n');
  const quoted = notes.map((n) => clipNote(n).split('\n').map((l) => `> ${l}`).join('\n')).join('\n>\n');
  return [
    head,
    `${USER_NOTES_HEADING}\n\n${quoted}`,
    `${CHILD_ANSWER_HEADING}\n\n${answer}`,
    ...wt,
    'If this changes your plan, adjust it; otherwise no reply is needed.',
    tail,
  ].join('\n\n');
}

export const USER_NOTES_HEADING = 'The user spoke to this child session directly:';
export const CHILD_ANSWER_HEADING = 'The child session then answered:';
// One intervention is quoted up to this length; a turn keeps this many.
export const MAX_NOTE_CHARS = 2000;
export const MAX_NOTES_PER_TURN = 20;
export function clipNote(text: string): string {
  const t = text.trim();
  return t.length > MAX_NOTE_CHARS ? `${t.slice(0, MAX_NOTE_CHARS)} … [cut]` : t;
}

// Parse the header of a report (for display). Null when `text` isn't one.
export function parseChildReport(text: string): { title: string; sessionId: string; ok: boolean; body: string } | null {
  const m = /^\[Child session "(.*?)" \(([A-Za-z0-9-]+)\) (finished after the user stepped in|finished|stopped with an error[^\]]*|was stopped by the user|was stopped by its parent session|was interrupted by an aie-studio restart)\]\n\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const body = m[4].replace(/\n\n\(Sent automatically by aie-studio[^)]*\)\s*$/, '');
  return { title: m[1], sessionId: m[2], ok: m[3].startsWith('finished'), body };
}
