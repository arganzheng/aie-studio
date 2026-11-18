// Model: Session.children — which child session a tool call of the parent's
// agent is about, so the chat can offer to open it.
export type ChildLink = { sessionId: string; title?: string };

const ID = /^[0-9a-fA-F-]{8,64}$/;

export function childLinkOfTool(name: string, input: unknown, output: string | undefined): ChildLink | null {
  const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (tool === 'spawn_child_session') {
    // The id is only known once the tool has answered: `… (id <uuid>).`
    const m = /\(id ([0-9a-fA-F-]{8,64})\)/.exec(output ?? '');
    if (!m) return null;
    return { sessionId: m[1], ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim() } : {}) };
  }
  if (tool === 'send_to_child_session' || tool === 'stop_child_session') {
    const id = typeof o.child_id === 'string' ? o.child_id.trim() : '';
    return ID.test(id) ? { sessionId: id } : null;
  }
  return null;
}
