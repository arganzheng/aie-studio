import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjectFiles } from './api';

// Model: web.FileMentions — the files of the checkout a session works in,
// for the prompt box's "@" picker and its chips. Nothing is fetched until
// `refresh` is first called (the picker opened, or the prompt has an "@");
// later calls fetch again only when the list is older than a few seconds.
const FRESH_MS = 5000;

export function useProjectFiles(projectId: string, worktree?: string | null): { files: string[]; refresh: () => void } {
  const [files, setFiles] = useState<string[]>([]);
  const key = `${projectId}|${worktree ?? ''}`;
  const st = useRef({ key: '', at: 0, busy: false });
  // Another checkout: its list is not this one's.
  useEffect(() => { if (st.current.key && st.current.key !== key) { st.current.at = 0; setFiles([]); } }, [key]);
  const refresh = useCallback(() => {
    const s = st.current;
    if (s.busy || (s.key === key && Date.now() - s.at < FRESH_MS)) return;
    s.busy = true;
    listProjectFiles(projectId, { worktree })
      .then((r) => { s.key = key; s.at = Date.now(); setFiles((prev) => (prev.length === r.files.length && prev.every((f, i) => f === r.files[i]) ? prev : r.files)); })
      .catch(() => {})
      .finally(() => { s.busy = false; });
  }, [key, projectId, worktree]);
  return { files, refresh };
}
