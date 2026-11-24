// Model: web.ToolCopy — a tool call as Markdown, for the Copy button on an
// opened tool call (like Devin's): something that reads well pasted into a
// PR, a doc or another chat. Paths are shown relative to the project (rel).

const LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'markdown', py: 'python', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', swift: 'swift', php: 'php', xml: 'xml',
};
export function langOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && LANG[m[1].toLowerCase()]) || '';
}

// A fence longer than any backtick run inside, so the block can't be closed early.
function fence(body: string, lang = ''): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${body.replace(/\n$/, '')}\n${f}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function diff(oldS: string, newS: string): string {
  const lines = [...oldS.split('\n').map((l) => `-${l}`), ...newS.split('\n').map((l) => `+${l}`)];
  return fence(lines.join('\n'), 'diff');
}

// Pure: the call (and its output, when it has one) as Markdown.
export function toolMarkdown(name: string, input: any, output: string | undefined, rel: (s: string) => string = (s) => s): string {
  const i = input && typeof input === 'object' ? input : {};
  const parts: string[] = [];
  const path = rel(str(i.file_path) || str(i.notebook_path) || str(i.path));
  switch (name) {
    case 'Bash': {
      parts.push(str(i.description) ? `**Bash** — ${str(i.description)}` : '**Bash**');
      parts.push(fence(str(i.command), 'bash'));
      break;
    }
    case 'Edit': {
      parts.push(`**Edit** \`${path}\``);
      parts.push(diff(str(i.old_string), str(i.new_string)));
      break;
    }
    case 'MultiEdit': {
      parts.push(`**MultiEdit** \`${path}\``);
      for (const e of Array.isArray(i.edits) ? i.edits : []) parts.push(diff(str(e?.old_string), str(e?.new_string)));
      break;
    }
    case 'Write': {
      parts.push(`**Write** \`${path}\``);
      parts.push(fence(str(i.content), langOf(path)));
      break;
    }
    case 'Read': {
      parts.push(`**Read** \`${path}\``);
      break;
    }
    case 'Grep': case 'Glob': {
      parts.push(`**${name}** \`${str(i.pattern)}\`${path ? ` in \`${path}\`` : ''}`);
      break;
    }
    default: {
      parts.push(`**${name}**`);
      if (Object.keys(i).length) parts.push(fence(JSON.stringify(i, null, 2), 'json'));
    }
  }
  if (output !== undefined && output !== '') parts.push(`Output:\n\n${fence(rel(output), name === 'Read' ? langOf(path) : '')}`);
  return parts.join('\n\n');
}
