import { describe, expect, it } from 'vitest';
import { toMarkdown } from '../toMarkdown';
import type { ExportMessage } from '../types';

const meta = { source: 'claude' as const, title: 't', exportedAt: '2026-11-20T00:00:00Z' };
const png = 'data:image/png;base64,AAAA';
const read: ExportMessage = { kind: 'tool', name: 'Read', input: { file_path: 'a.png' }, output: '', images: [png] };

describe('toMarkdown tool images', () => {
  it('embeds images a tool returned', () => {
    const md = toMarkdown([read], meta);
    expect(md).toContain('#### 🛠 Read');
    expect(md).toContain(`![](${png})`);
  });

  it('omits data: images when embedImages is off', () => {
    const md = toMarkdown([read], meta, { embedImages: false });
    expect(md).not.toContain(png);
    expect(md).toContain('_[image omitted]_');
  });

  it('keeps tools without images unchanged', () => {
    const md = toMarkdown([{ kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'x' }], meta);
    expect(md).not.toContain('![](');
  });

  it('still handles user images', () => {
    const md = toMarkdown([{ kind: 'user', text: 'hi', images: [png] }], meta);
    expect(md).toContain(`![](${png})`);
  });
});
