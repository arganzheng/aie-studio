// Model: Session.tasks — what Claude Code tells the model when a background
// task (a command run in the background, a background agent) ends. The CLI
// puts it into the conversation as a user message, but the user never typed
// it. Parsed here so the chat shows it as what it is: a task that finished
// is a row in Claude's work; one that failed or was cut off (the session it
// ran in ended) is a card the user should see.

export type TaskNoteStatus = 'completed' | 'failed' | 'killed' | 'stopped' | string;

export type TaskNote = {
  ids: string[];
  status: TaskNoteStatus;
  summary: string;
  // The CLI's explanation, written for the model.
  note?: string;
  // A background agent's final report.
  result?: string;
  outputFile?: string;
};

const BLOCK_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? decode(m[1].trim()) : undefined;
}

// Pure: the notifications a user message carries, or null when it is not
// (only) task notifications.
export function parseTaskNotifications(text: string | undefined): TaskNote[] | null {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const notes: TaskNote[] = [];
  const rest = text.replace(BLOCK_RE, (_all, body: string) => {
    const ids = [...body.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)].map((m) => m[1].trim()).filter((id) => id && !id.startsWith('__'));
    notes.push({
      ids,
      status: (tag(body, 'status') ?? '').toLowerCase(),
      summary: tag(body, 'summary') ?? 'A background task ended',
      note: tag(body, 'note'),
      result: tag(body, 'result'),
      outputFile: tag(body, 'output-file'),
    });
    return '';
  });
  if (!notes.length || rest.trim()) return null;
  return notes;
}

// A task that did not get to the end on its own: the user should know.
export function taskNoteFailed(n: TaskNote): boolean {
  return n.status === 'failed' || n.status === 'stopped';
}

// Pure: notifications that are just part of the work (every task finished,
// or was stopped on purpose) — a row in the work group, not a card.
export function quietTaskNotes(text: string | undefined): TaskNote[] | null {
  const notes = parseTaskNotifications(text);
  return notes && !notes.some(taskNoteFailed) ? notes : null;
}

// What a card says the task came to.
export function taskNoteTitle(n: TaskNote): string {
  switch (n.status) {
    case 'failed': return 'Background task failed';
    case 'stopped': return "Background task didn't finish";
    case 'killed': return 'Background task stopped';
    case 'completed': return 'Background task finished';
    default: return 'Background task ended';
  }
}
