// Model: Session.activity — what a running session is doing right now, in a
// few words, for its row in the Sessions tree: the tool call it last made.

const KEYS: Record<string, string[]> = {
  Bash: ['description', 'command'],
  Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], NotebookEdit: ['notebook_path'],
  Glob: ['pattern'], Grep: ['pattern'],
  WebFetch: ['url'], WebSearch: ['query'],
  Task: ['description', 'prompt'], Agent: ['description', 'prompt'],
  spawn_child_session: ['title'], send_to_child_session: ['message'],
};
const ANY = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'title', 'prompt'];
export const MAX_ACTIVITY_CHARS = 80;

export function toolActivity(name: unknown, input: unknown, cwd = ''): string {
  if (typeof name !== 'string' || !name) return '';
  // MCP tools are "mcp__<server>__<tool>": the tool is what matters here.
  const short = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  let detail = '';
  for (const k of KEYS[short] ?? ANY) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) { detail = v; break; }
  }
  // Paths inside the session's directory read better relative to it (macOS
  // reports /tmp as /private/tmp).
  if (cwd) for (const root of [cwd, `/private${cwd}`]) if (detail.startsWith(`${root}/`)) { detail = detail.slice(root.length + 1); break; }
  detail = detail.replace(/\s+/g, ' ').trim();
  const text = detail ? `${short}: ${detail}` : short;
  return text.length > MAX_ACTIVITY_CHARS ? `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…` : text;
}

// The activity an SDK message leaves the session in: its last top-level tool
// call. Null = this message says nothing about it.
export function activityAfter(m: any, cwd = ''): string | null {
  if (m?.type === 'result') return '';
  if (m?.type !== 'assistant' || m.parent_tool_use_id) return null;
  const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
  const tools = blocks.filter((b: any) => b?.type === 'tool_use');
  if (tools.length === 0) return null;
  const last = tools[tools.length - 1];
  return toolActivity(last.name, last.input, cwd);
}
