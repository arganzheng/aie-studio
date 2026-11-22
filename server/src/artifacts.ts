import path from 'node:path';

// Model: web.ArtifactsView — what a session produced and what it was handed,
// read from its transcript: the files Claude wrote or edited (by its file
// tools) and the files the user attached to a prompt (server.SessionAttachments,
// named in the prompt under ATTACHED_HEAD).

export const ATTACHED_HEAD = 'Attached files (saved on this machine; read them with your tools as needed):';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export type ArtifactFile = {
  // Relative to the project when inside it, else absolute.
  path: string;
  inProject: boolean;
  // The session created it (its first touch was Write) or changed it.
  created: boolean;
  edits: number;
  lastAt: string | null;
  // Only seen in a shell command's redirect (`> f`, `>> f`, `tee f`), not a file tool.
  viaShell?: boolean;
};
// A file attached by path (uploaded), or an image pasted into a prompt (kept
// in the transcript itself; `ref` = "<message index>.<block index>" among the
// transcript's user/assistant messages).
export type ArtifactAttachment =
  | { kind: 'file'; path: string; name: string; at: string | null }
  | { kind: 'image'; ref: string; name: string; mediaType: string; at: string | null };

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Pure: the pasted image at `ref`, if there is one.
export function transcriptImage(msgs: readonly any[], ref: string): { mediaType: string; data: Buffer } | null {
  const m = /^(\d+)\.(\d+)$/.exec(ref);
  if (!m) return null;
  const b = msgs[Number(m[1])]?.message?.content?.[Number(m[2])];
  if (msgs[Number(m[1])]?.type !== 'user' || b?.type !== 'image' || b.source?.type !== 'base64' || !IMAGE_TYPES.has(b.source.media_type)) return null;
  return { mediaType: b.source.media_type, data: Buffer.from(String(b.source.data ?? ''), 'base64') };
}
export type SessionArtifacts = { files: ArtifactFile[]; attachments: ArtifactAttachment[] };

function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string);
}

// Pure: the "- /abs/path" lines under ATTACHED_HEAD.
export function attachedPaths(text: string): string[] {
  const i = text.lastIndexOf(ATTACHED_HEAD);
  if (i < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(i + ATTACHED_HEAD.length).split('\n')) {
    if (!line.trim()) { if (out.length) break; continue; }
    if (!line.startsWith('- /')) break;
    out.push(line.slice(2).trim());
  }
  return out;
}

// Pure: files a shell command writes by redirect or tee — what Claude does
// when it writes with Bash (`cat > f <<EOF`, `echo x >> f`, `... | tee f`).
// Conservative: plain paths only (no variables, globs or substitutions).
export function shellWrites(cmd: string): string[] {
  const out = new Set<string>();
  // Drop heredoc bodies: their lines are data, not commands.
  const lines: string[] = [];
  let end: string | null = null;
  for (const line of cmd.split('\n')) {
    if (end !== null) { if (line.trim() === end) end = null; continue; }
    lines.push(line);
    const h = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (h) end = h[2];
  }
  const text = lines.join('\n');
  const plain = (p: string) => /^[A-Za-z0-9_./~+@,-]+$/.test(p) && !p.startsWith('/dev/') && p !== '&1' && p !== '&2';
  for (const m of text.matchAll(/(?:^|[\s;&|(])\d?>>?\s*(['"]?)([^\s;&|<>()'"]+)\1/g)) if (plain(m[2])) out.add(m[2]);
  for (const m of text.matchAll(/\btee\s+(?:-a\s+)?(['"]?)([^\s;&|<>()'"]+)\1/g)) if (plain(m[2])) out.add(m[2]);
  return [...out];
}

// Pure. Newest first in both lists.
export function sessionArtifacts(msgs: readonly any[], projectPath: string): SessionArtifacts {
  const files = new Map<string, ArtifactFile>();
  const attachments = new Map<string, ArtifactAttachment>();
  const root = projectPath.replace(/\/+$/, '');
  const touch = (p: string, create: boolean, viaShell: boolean, at: string | null) => {
    if (p.startsWith('~')) return;
    const norm = path.resolve(root || '/', p);
    const inProject = !!root && (norm === root || norm.startsWith(root + '/'));
    const key = inProject ? path.relative(root, norm) : norm;
    const prev = files.get(key);
    files.delete(key);
    files.set(key, {
      path: key,
      inProject,
      created: prev ? prev.created : create,
      edits: (prev?.edits ?? 0) + 1,
      lastAt: at ?? prev?.lastAt ?? null,
      ...(viaShell && (!prev || prev.viaShell) ? { viaShell: true } : {}),
    });
  };
  let pasted = 0;
  msgs.forEach((m, mi) => {
    const content = m?.message?.content;
    const at = typeof m?.timestamp === 'string' ? m.timestamp : null;
    if (m?.type === 'user') {
      for (const t of textsOf(content)) {
        for (const p of attachedPaths(t)) {
          attachments.delete(p);
          attachments.set(p, { kind: 'file', path: p, name: path.basename(p), at });
        }
      }
      // Images the user pasted (not ones a tool returned: those come in tool_result).
      if (Array.isArray(content) && !content.some((b: any) => b?.type === 'tool_result')) {
        content.forEach((b: any, bi: number) => {
          if (b?.type === 'image' && b.source?.type === 'base64' && IMAGE_TYPES.has(b.source.media_type)) {
            const ref = `${mi}.${bi}`;
            attachments.set(ref, { kind: 'image', ref, name: `Pasted image ${++pasted}`, mediaType: b.source.media_type, at });
          }
        });
      }
    }
    if (m?.type !== 'assistant' || !Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      if (WRITE_TOOLS.has(b.name)) {
        const abs = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof abs === 'string' && abs) touch(abs, b.name === 'Write', false, at);
      } else if (b.name === 'Bash' && typeof b.input?.command === 'string') {
        for (const p of shellWrites(b.input.command)) touch(p, false, true, at);
      }
    }
  });
  return { files: [...files.values()].reverse(), attachments: [...attachments.values()].reverse() };
}

// Pure: is `abs` inside this user's own attachments directory?
export function ownAttachment(root: string, uid: string, abs: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(uid) || !path.isAbsolute(abs)) return false;
  const mine = path.join(root, uid) + path.sep;
  return path.resolve(abs).startsWith(mine);
}
