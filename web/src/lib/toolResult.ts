// Shared parsing of tool_result blocks for the Claude chat panels.

export type ToolOutput = { text: string; images?: string[] };

function imageDataUrl(block: any): string | null {
  const src = block?.source;
  if (block?.type === 'image' && src?.type === 'base64' && src.data && src.media_type) {
    return `data:${src.media_type};base64,${src.data}`;
  }
  return null;
}

/** A tool_result's `content` → its text plus any images (e.g. Read on a .png). */
export function parseToolResultContent(content: unknown): ToolOutput {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: JSON.stringify(content) };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of content) {
    const url = imageDataUrl(c);
    if (url) images.push(url);
    else texts.push(typeof c?.text === 'string' ? c.text : '');
  }
  return images.length ? { text: texts.join('\n'), images } : { text: texts.join('\n') };
}

/**
 * Claude Code follows an image tool_result with an isMeta user record such as
 * "[Image: original 2560x1520, displayed at 2000x1188. …]" — a note for the
 * model, not something the user typed. It must not render as a user bubble.
 * The transcript marks it isMeta; the live SDK stream marks it isSynthetic.
 */
export function isImageSizeNote(ev: any): boolean {
  if (ev?.type !== 'user' || !(ev.isMeta || ev.isSynthetic)) return false;
  const c = ev.message?.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) && c.length === 1 && c[0]?.type === 'text' ? c[0].text : null;
  return typeof text === 'string' && text.startsWith('[Image: ');
}
