import type { SubagentInfo } from '../api';

// Model: web.SessionList tree / web.SubagentPanel — wording shared by both.

export function subagentStatusLabel(s: Pick<SubagentInfo, 'status' | 'lastTool'>): string {
  if (s.status === 'running') return s.lastTool ? `Running · ${s.lastTool}` : 'Running';
  if (s.status === 'done') return 'Done';
  if (s.status === 'failed') return 'Failed';
  return 'Stopped';
}

// "3/5" for the parent row: finished (any way) out of all.
export function subagentProgress(list: readonly Pick<SubagentInfo, 'status'>[]): { settled: number; total: number; running: number; label: string } {
  const total = list.length;
  const running = list.filter((s) => s.status === 'running').length;
  return { settled: total - running, total, running, label: `${total - running}/${total}` };
}
