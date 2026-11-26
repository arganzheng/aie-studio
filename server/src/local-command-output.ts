// What a slash command Claude Code ran itself (/model, /context …) printed.
// The transcript keeps it as a system record (subtype local_command) whose
// parentUuid is the command's own record; getSessionMessages() does not
// return its content, so ReadSdkTranscript reads it from the file and sends
// it along with the command (model: web.LocalCommandCard).
import { promises as fsp } from 'node:fs';
import { findTranscript } from './claude-paths.js';

// command record uuid → the output record's content (tags included).
export function localCommandOutputs(jsonl: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"local_command"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === 'system' && o.subtype === 'local_command' && typeof o.parentUuid === 'string' && typeof o.content === 'string') {
      out.set(o.parentUuid, o.content);
    }
  }
  return out;
}

export async function readLocalCommandOutputs(cwd: string, sessionId: string): Promise<Map<string, string>> {
  try {
    const file = await findTranscript(cwd, sessionId);
    return file ? localCommandOutputs(await fsp.readFile(file, 'utf8')) : new Map();
  } catch {
    return new Map();
  }
}
