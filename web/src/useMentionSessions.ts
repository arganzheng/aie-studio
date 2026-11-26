import { useCallback, useRef, useState } from 'react';
import type { SessionRow } from './lib/sessionList';
import { listAllSessions } from './api';
import type { MentionSession } from './lib/mentions';

// Model: web.SessionMentions — the project's sessions (Claude and Devin, not
// archived), for the prompt box's Sessions picker and its chips. Fetched when
// first wanted, then again only when older than a few seconds.
const FRESH_MS = 5000;

export function useMentionSessions(projectId: string): { sessions: MentionSession[]; refresh: () => void; rowOf: (id: string) => SessionRow | undefined } {
  const [sessions, setSessions] = useState<MentionSession[]>([]);
  const st = useRef({ key: '', at: 0, busy: false });
  // The rows as listed, to open one from its chip.
  const rows = useRef(new Map<string, SessionRow>());
  const rowOf = useCallback((id: string) => rows.current.get(id), []);
  const refresh = useCallback(() => {
    const s = st.current;
    if (s.busy || (s.key === projectId && Date.now() - s.at < FRESH_MS)) return;
    s.busy = true;
    listAllSessions(projectId)
      .then((list) => {
        s.key = projectId; s.at = Date.now();
        rows.current = new Map(list.filter((r) => !r.archived).map((r) => [r.sessionId, r]));
        setSessions(list.filter((r) => !r.archived).map((r) => ({ id: r.sessionId, title: r.title, kind: r.kind, updatedAt: r.updatedAt })));
      })
      .catch(() => {})
      .finally(() => { s.busy = false; });
  }, [projectId]);
  return { sessions, refresh, rowOf };
}
