import { describe, expect, it } from 'vitest';
import { langOf, toolMarkdown } from '../toolMarkdown';

describe('toolMarkdown', () => {
  it('writes a command with its description and output', () => {
    expect(toolMarkdown('Bash', { command: 'ls _plugins | head', description: 'List plugins' }, 'a.rb\nb.rb\n')).toBe(
      '**Bash** — List plugins\n\n```bash\nls _plugins | head\n```\n\nOutput:\n\n```\na.rb\nb.rb\n```',
    );
  });
  it('writes an edit as a diff, with the path relative', () => {
    const md = toolMarkdown('Edit', { file_path: '/p/src/a.ts', old_string: 'x = 1', new_string: 'x = 2' }, 'ok', (s) => s.replace('/p/', ''));
    expect(md).toContain('**Edit** `src/a.ts`');
    expect(md).toContain('```diff\n-x = 1\n+x = 2\n```');
  });
  it('fences content that has backticks in it', () => {
    const md = toolMarkdown('Write', { file_path: 'a.md', content: '```js\nx\n```' }, undefined);
    expect(md).toBe('**Write** `a.md`\n\n````markdown\n```js\nx\n```\n````');
  });
  it('falls back to the input as JSON', () => {
    expect(toolMarkdown('WebFetch', { url: 'https://x' }, undefined)).toBe('**WebFetch**\n\n```json\n{\n  "url": "https://x"\n}\n```');
  });
  it('knows common languages', () => {
    expect(langOf('a/b.tsx')).toBe('tsx');
    expect(langOf('Makefile')).toBe('');
  });
});
