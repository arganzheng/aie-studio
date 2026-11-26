// A slash command Claude Code ran itself (/model, /context …) leaves user-role
// records in the conversation: a caveat for the model, the command, and its
// output. None of it was typed as a prompt, so the chat shows one small card
// per command instead of user bubbles full of tags.
//
// /compact is a card too: the summary that replaced the earlier turns (lib/
// compactNote.ts) goes into it, collapsed (absorbCompactSummary). A compaction
// nobody typed (automatic) keeps compactNote's note of its own.

export type LocalCommandPart =
  | { kind: 'caveat' }
  | { kind: 'command'; command: string }
  | { kind: 'output'; stdout: string; stderr: string }
  | { kind: 'text'; text: string };

export type LocalCommandMsg = { role: 'localcmd'; command: string; output?: { stdout: string; stderr: string }; summary?: string };

const TAG_RE = /\s*<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/y;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Terminal-only hints in an output, e.g. "Compacted (ctrl+o to see full summary)".
const KEY_HINT_RE = /\s*\(ctrl\+[a-z] to [^)]*\)/gi;

// The tags of `text` in order, or null when it holds anything besides them.
function readTags(text: string): Array<[tag: string, body: string]> | null {
  const tags: Array<[string, string]> = [];
  let pos = 0;
  while (true) {
    TAG_RE.lastIndex = pos;
    const m = TAG_RE.exec(text);
    if (!m) break;
    tags.push([m[1], m[2]]);
    pos = TAG_RE.lastIndex;
  }
  return tags.length && text.slice(pos).trim() === '' ? tags : null;
}

function splitOne(text: string): LocalCommandPart[] {
  const tags = readTags(text);
  if (!tags) return [{ kind: 'text', text }];
  const parts: LocalCommandPart[] = [];
  let name: string | null = null;
  let args = '';
  const flushCommand = () => {
    if (name !== null) parts.push({ kind: 'command', command: args ? `${name} ${args}` : name });
    name = null; args = '';
  };
  for (const [tag, body] of tags) {
    const value = body.replace(ANSI_RE, '').trim();
    if (tag === 'command-name') { flushCommand(); name = value; }
    else if (tag === 'command-args') args = value;
    else if (tag === 'command-message') { /* the name again, without the slash */ }
    else {
      flushCommand();
      if (tag === 'local-command-caveat') parts.push({ kind: 'caveat' });
      else {
        const last = parts[parts.length - 1];
        const out = last?.kind === 'output' ? last : { kind: 'output' as const, stdout: '', stderr: '' };
        if (tag === 'local-command-stdout') out.stdout = value.replace(KEY_HINT_RE, ''); else out.stderr = value;
        if (out !== last) parts.push(out);
      }
    }
  }
  flushCommand();
  return parts;
}

// Classify the text blocks of one user message.
export function splitLocalCommandTexts(texts: readonly string[]): LocalCommandPart[] {
  return texts.flatMap(splitOne);
}

// Pairs an output with the latest command still lacking one. False when there
// is none (the caller then shows the output on its own).
export function attachLocalCommandOutput<M extends { role: string }>(msgs: M[], output: { stdout: string; stderr: string }): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as M & Partial<LocalCommandMsg>;
    if (m.role !== 'localcmd') continue;
    if (m.output) return false;
    msgs[i] = { ...m, output };
    return true;
  }
  return false;
}

// What the card shows: one line when the output is a single short line.
export function localCommandView(m: { command: string; output?: { stdout: string; stderr: string } }): { failed: boolean; inline: string | null; body: string | null } {
  const stderr = m.output?.stderr ?? '';
  const text = (stderr || m.output?.stdout || '').trim();
  const failed = !!stderr;
  if (!text) return { failed, inline: null, body: null };
  const oneLine = !text.includes('\n') && text.length <= 80;
  // `code` marks mean nothing in a plain line.
  return oneLine ? { failed, inline: text.replace(/`/g, ''), body: null } : { failed, inline: null, body: text };
}

// The same, as one line of plain text (exports).
export function localCommandText(m: { command: string; output?: { stdout: string; stderr: string } }): string {
  const out = (m.output?.stderr || m.output?.stdout || '').trim();
  return [m.command, out].filter(Boolean).join(m.command && !out.includes('\n') ? ' → ' : '\n');
}

// Adds an output to a message list (in place): onto the command waiting for
// it; else onto the "/command" the user just typed (live, the command shows as
// their own bubble first); else as a card of its own.
export function applyLocalCommandOutput<M extends { role: string }>(
  msgs: M[],
  output: { stdout: string; stderr: string },
  make: (command: string, output: { stdout: string; stderr: string }) => M,
): void {
  if (attachLocalCommandOutput(msgs, output)) return;
  if (answerTypedCommand(msgs, output.stderr || output.stdout, make)) return;
  msgs.push(make('', output));
}

// Live, Claude Code answers a slash command it ran itself with an assistant
// message that no model wrote (model "<synthetic>").
export function isSyntheticReply(ev: any): boolean {
  return ev?.type === 'assistant' && ev.message?.model === '<synthetic>';
}

// Folds such an answer into the "/command" bubble right before it (in place).
// False when the last message is not one: the answer then stays a message.
export function answerTypedCommand<M extends { role: string }>(
  msgs: M[],
  text: string,
  make: (command: string, output: { stdout: string; stderr: string }) => M,
): boolean {
  const last = msgs[msgs.length - 1] as (M & { text?: unknown; images?: unknown[] }) | undefined;
  if (last?.role !== 'user' || typeof last.text !== 'string' || !/^\/\S/.test(last.text.trim()) || last.images?.length) return false;
  msgs[msgs.length - 1] = make(last.text.trim(), { stdout: text.replace(ANSI_RE, '').trim(), stderr: '' });
  return true;
}

// Newer Claude Code writes a command's output as a system record instead
// (transcript: subtype local_command; live SDK stream: local_command_output),
// with or without the stdout/stderr tags. null: not such a record, or one
// without any output.
export function localCommandOutputOf(ev: any): { stdout: string; stderr: string } | null {
  if (ev?.type !== 'system' || (ev.subtype !== 'local_command' && ev.subtype !== 'local_command_output')) return null;
  if (typeof ev.content !== 'string' || !ev.content.trim()) return null;
  const parts = splitOne(ev.content);
  const out = parts.find((p): p is Extract<LocalCommandPart, { kind: 'output' }> => p.kind === 'output');
  if (out) return { stdout: out.stdout, stderr: out.stderr };
  const text = ev.content.replace(ANSI_RE, '').replace(KEY_HINT_RE, '').trim();
  if (parts.some((p) => p.kind !== 'text')) return null;
  return { stdout: text, stderr: '' };
}

// A /compact card takes the summary the compaction left right before it (the
// summary is recorded first): pops that message off msgs and returns its text.
export function absorbCompactSummary<M extends { role: string }>(
  msgs: M[],
  command: string,
  summaryOf: (m: M) => string | null,
): string | undefined {
  if (!/^\/compact\b/.test(command)) return undefined;
  const last = msgs[msgs.length - 1];
  const summary = last ? summaryOf(last) : null;
  if (summary === null) return undefined;
  msgs.pop();
  return summary;
}

// Live, the summary arrives after the "/compact" the user typed (and before
// its output): turn that bubble, or a /compact card still without a summary,
// into a card holding it (in place). False when the last message is neither.
export function giveSummaryToCompact<M extends { role: string }>(
  msgs: M[],
  summary: string,
  make: (command: string) => M,
): boolean {
  const i = msgs.length - 1;
  const last = msgs[i] as (M & { text?: unknown; images?: unknown[]; command?: unknown; summary?: string }) | undefined;
  if (!last) return false;
  if (last.role === 'localcmd' && typeof last.command === 'string' && /^\/compact\b/.test(last.command) && !last.summary) {
    msgs[i] = { ...last, summary };
    return true;
  }
  if (last.role === 'user' && typeof last.text === 'string' && /^\/compact\b/.test(last.text.trim()) && !last.images?.length) {
    msgs[i] = { ...make(last.text.trim()), summary };
    return true;
  }
  return false;
}
