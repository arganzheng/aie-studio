import { describe, expect, it } from 'vitest';
import { appPath, previewUrl } from '../../components/PreviewView';
import { openTab, parseSideState, updateTab, type SideState } from '../sidePanel';

describe('preview paths', () => {
  it('opens through the boot page with the app path', () => {
    expect(previewUrl(5173, '/about?x=1')).toBe('/preview/5173/__aie/boot?to=%2Fabout%3Fx%3D1');
    expect(previewUrl(5173, 'about')).toBe('/preview/5173/__aie/boot?to=%2Fabout');
  });
  it("reads the app's path back, prefix or not", () => {
    expect(appPath(5173, '/preview/5173/about', '?a=1', '#h')).toBe('/about?a=1#h');
    expect(appPath(5173, '/preview/5173')).toBe('/');
    expect(appPath(5173, '/about')).toBe('/about');
    expect(appPath(5173, '/preview/5173/__aie/boot', '?to=/')).toBe('/');
  });
});

describe('preview tabs', () => {
  const s: SideState = { tabs: [{ id: 'a', kind: 'changes', target: '@follow' }], active: 'a' };
  it('one tab per port, focused again when asked twice', () => {
    const one = openTab(s, { kind: 'preview', port: 5173, path: '/' }, () => 'p');
    expect(one.tabs.map((t) => t.id)).toEqual(['a', 'p']);
    const again = openTab({ ...one, active: 'a' }, { kind: 'preview', port: 5173, path: '/x' }, () => 'q');
    expect([again.tabs.length, again.active]).toEqual([2, 'p']);
  });
  it('keeps the path it was at, and survives a reload of the page', () => {
    const one = updateTab(openTab(s, { kind: 'preview', port: 3000, path: '/' }, () => 'p'), 'p', { path: '/cart' });
    const back = parseSideState(JSON.stringify(one), false);
    expect(back.tabs[1]).toEqual({ id: 'p', kind: 'preview', port: 3000, path: '/cart' });
    expect(parseSideState(JSON.stringify({ tabs: [{ id: 'x', kind: 'preview', port: 80, path: '/' }] }), false).tabs).toEqual([]);
  });
});
