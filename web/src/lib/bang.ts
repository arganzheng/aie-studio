// Model: web.BangCommand. `!command` in a Claude (SDK) chat input runs a shell
// command in the project directory (server.RunBangCommand) instead of sending
// a prompt; its output joins the conversation with the next prompt, recorded
// with the same <bash-input>/<bash-stdout>/<bash-stderr> tags Claude Code's
// bash mode writes — so CLI-made `!` records render the same way.

export function isBangInput(text: string): boolean {
  return /^\s*!/.test(text);
}

// The command to run, or null when the input isn't a (non-empty) `!` command.
export function bangCommand(text: string): string | null {
  if (!isBangInput(text)) return null;
  const cmd = text.trim().slice(1).trim();
  return cmd || null;
}

export type BangPart =
  | { kind: 'input'; command: string }
  | { kind: 'output'; stdout: string; stderr: string }
  | { kind: 'text'; text: string };

const unescape = (s: string) => s.replace(/<\\\/(bash-(?:input|stdout|stderr))>/g, '</$1>');
const INPUT_RE = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/;
const OUTPUT_RE = /^\s*<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/;

// Classify the text blocks of one user message.
export function splitBangTexts(texts: readonly string[]): BangPart[] {
  return texts.map((t): BangPart => {
    const i = INPUT_RE.exec(t);
    if (i) return { kind: 'input', command: unescape(i[1]) };
    const o = OUTPUT_RE.exec(t);
    if (o) return { kind: 'output', stdout: unescape(o[1]), stderr: unescape(o[2] ?? '') };
    return { kind: 'text', text: t };
  });
}
