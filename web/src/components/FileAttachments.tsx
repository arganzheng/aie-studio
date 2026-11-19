import { useCallback, useRef, useState } from 'react';
import { ApiError, uploadFile } from '../api';
import { formatSize, type FileAttachment, type SentFile } from '../lib/fileAttachments';
import { newAttachmentId } from '../lib/imageAttachments';

// Model: web.FileAttachments — "files waiting to be sent" for a session
// panel: a hook holding the list (each file uploads as soon as it is picked,
// through the same api.uploadFile the Files panel uses) and the chip strip.

export function useFileAttachments(projectId: string, onNotice?: (msg: string) => void) {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  // Removed while uploading: the result is dropped when it lands.
  const gone = useRef(new Set<string>());
  const patch = (id: string, p: Partial<FileAttachment>) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const addFiles = useCallback((picked: FileList | File[]) => {
    for (const file of Array.from(picked)) {
      const id = newAttachmentId();
      setFiles((prev) => [...prev, { id, name: file.name, size: file.size, pct: 0, state: 'uploading' }]);
      uploadFile(projectId, '', file, { attach: true, onProgress: (sent, total) => patch(id, { pct: total > 0 ? Math.round((sent / total) * 100) : 0 }) })
        .then((r) => { if (!gone.current.has(id)) patch(id, { state: 'ready', pct: 100, path: r.path }); })
        .catch((e) => {
          const msg = e instanceof ApiError || e instanceof Error ? e.message : 'upload failed';
          patch(id, { state: 'failed', error: msg });
          onNotice?.(`Upload "${file.name}" failed: ${msg}`);
        });
    }
  }, [projectId, onNotice]);
  const remove = useCallback((id: string) => { gone.current.add(id); setFiles((prev) => prev.filter((f) => f.id !== id)); }, []);
  const clear = useCallback(() => setFiles([]), []);
  return { files, addFiles, remove, clear };
}

// Chips above the input: name, size, upload progress, a × each.
export function FileAttachmentStrip({ files, onRemove }: { files: readonly FileAttachment[]; onRemove: (id: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="chat-pending-files">
      {files.map((f) => (
        <div key={f.id} className={`file-chip ${f.state}`} title={f.state === 'failed' ? f.error : f.path ?? f.name}>
          <span className="file-chip-icon" aria-hidden="true">📄</span>
          <span className="file-chip-name">{f.name}</span>
          <span className="file-chip-meta">{f.state === 'uploading' ? `${f.pct}%` : f.state === 'failed' ? 'failed' : formatSize(f.size)}</span>
          <button type="button" className="file-chip-del" onClick={() => onRemove(f.id)} title="Remove" aria-label={`Remove ${f.name}`}>×</button>
        </div>
      ))}
    </div>
  );
}

// The files a sent prompt carried, under the user's message.
export function SentFileChips({ files }: { files: readonly SentFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="msg-files">
      {files.map((f) => (
        <span key={f.path} className="file-chip sent" title={f.path}>
          <span className="file-chip-icon" aria-hidden="true">📄</span>
          <span className="file-chip-name">{f.name}</span>
        </span>
      ))}
    </div>
  );
}
