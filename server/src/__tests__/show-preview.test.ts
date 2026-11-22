import { describe, expect, it } from 'vitest';
import { showPreviewReply, VIEW_INSTRUCTIONS } from '../sdk-session.js';
import { isOwnTool } from '../permission-mode.js';

describe('show_preview', () => {
  it('opens a page that is up, and says so', () => {
    const r = showPreviewReply(5173, '/', { title: 'Notes' }, 1);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Opened port 5173 — "Notes"');
  });
  it('names the path when it is not the root', () => {
    expect(showPreviewReply(8000, '/compare/', {}, 2).text).toContain('port 8000 (/compare/)');
  });
  it('is an error when nothing serves a page there', () => {
    const r = showPreviewReply(5173, '/', null, 1);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Start the server first');
  });
  it('says when nobody is looking', () => {
    const r = showPreviewReply(5173, '/', {}, 0);
    expect(r.isError).toBe(false);
    expect(r.text).toContain('nobody has this session open');
  });
  it('is one of the app\'s own tools (no permission prompt), and tells Claude not to paste localhost links', () => {
    expect(isOwnTool('mcp__aie_view__show_preview')).toBe(true);
    expect(VIEW_INSTRUCTIONS).toContain('Do not paste localhost URLs');
  });
});
