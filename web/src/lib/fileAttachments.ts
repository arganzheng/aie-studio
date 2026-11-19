// Model: web.FileAttachments — files (not images) handed to a session from
// the prompt input. Each is uploaded to the server's attachment store
// (server.SessionAttachments) and named in the prompt by its path there; the
// agent reads it with its own tools. Pure helpers; components/FileAttachments
// holds the state.

export type FileAttachment = {
  id: string;
  name: string;
  size: number;
  // 0–100 while it uploads.
  pct: number;
  state: 'uploading' | 'ready' | 'failed';
  // Absolute path on the server, once uploaded.
  path?: string;
  error?: string;
};

export type SentFile = { path: string; name: string };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// The line that opens the block. The agent reads it as an instruction; the
// panel reads it to show the files as chips instead of text.
export const ATTACHED_HEAD = 'Attached files (saved on this machine; read them with your tools as needed):';

// Pure: the prompt with its attachments named at the end.
export function withAttachedFiles(text: string, files: readonly { path?: string }[]): string {
  const paths = files.map((f) => f.path).filter((p): p is string => !!p);
  if (paths.length === 0) return text;
  const block = `${ATTACHED_HEAD}\n${paths.map((p) => `- ${p}`).join('\n')}`;
  return text.trim() ? `${text.trim()}\n\n${block}` : block;
}

// Pure: a sent prompt split back into what the user typed and the files it
// carried. Text without the block comes back unchanged.
export function parseAttachedFiles(text: string): { text: string; files: SentFile[] } {
  const at = text.lastIndexOf(ATTACHED_HEAD);
  if (at < 0 || (at > 0 && text[at - 1] !== '\n')) return { text, files: [] };
  const lines = text.slice(at + ATTACHED_HEAD.length).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || !lines.every((l) => l.startsWith('- /'))) return { text, files: [] };
  const files = lines.map((l) => { const p = l.slice(2); return { path: p, name: p.slice(p.lastIndexOf('/') + 1) }; });
  return { text: text.slice(0, at).trim(), files };
}

// ---- drag and drop ----

// Is the thing being dragged over the input a set of files (not text, not a
// link)? `types` is DataTransfer.types.
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.from(types).includes('Files');
}

// Pure: the files of a drop, without the folders (a dropped folder shows up
// as an entry that can't be read as a file) and, for an input that only takes
// images, without anything else.
export function droppedFiles(
  items: ArrayLike<{ kind: string; getAsFile: () => File | null; webkitGetAsEntry?: () => { isDirectory: boolean } | null }> | null | undefined,
  anyFile: boolean,
): File[] {
  const out: File[] = [];
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) continue;
    const f = item.getAsFile();
    if (f && (anyFile || f.type.startsWith('image/'))) out.push(f);
  }
  return out;
}
