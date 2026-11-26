import type { ReactNode } from 'react';
import { localCommandView } from '../lib/localCommand';

// A slash command Claude Code ran itself (/model, /context …) with its output:
// on the user's side of the chat, but a card rather than a prompt bubble.
// renderBody: how to show a long output (it is often Markdown, e.g. /context).
// summary: what a /compact replaced the earlier conversation with; collapsed.
export function LocalCommandCard({ command, output, summary, renderBody }: {
  command: string;
  output?: { stdout: string; stderr: string };
  summary?: string;
  renderBody?: (text: string) => ReactNode;
}) {
  const view = localCommandView({ command, output });
  return (
    <div className={`msg msg-local-cmd${view.failed ? ' failed' : ''}`}>
      <div className="local-cmd-head">
        <span className="local-cmd-mark" aria-hidden="true">{view.failed ? '⚠' : '⌘'}</span>
        {command && <span className="local-cmd-name">{command}</span>}
        {view.inline !== null
          ? <span className="local-cmd-result">{view.inline}</span>
          : !command && <span className="local-cmd-result">command output</span>}
      </div>
      {view.body !== null && (renderBody && !view.failed
        ? <div className="local-cmd-body local-cmd-md">{renderBody(view.body)}</div>
        : <pre className="local-cmd-body">{view.body}</pre>)}
      {summary && (
        <details className="local-cmd-summary">
          <summary>Earlier conversation, compacted into a summary</summary>
          <div className="local-cmd-body local-cmd-md">{renderBody ? renderBody(summary) : summary}</div>
        </details>
      )}
    </div>
  );
}
