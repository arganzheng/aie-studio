import { describe, expect, it } from 'vitest';
import { forwardCookie, injectIntoHtml, parseLsof, previewTarget, rewriteLocation } from '../preview.js';

describe('previewTarget', () => {
  it('splits port and rest', () => {
    expect(previewTarget('/preview/5173/src/main.ts?t=1')).toEqual({ port: 5173, rest: '/src/main.ts?t=1', bare: false });
    expect(previewTarget('/preview/5173/')).toEqual({ port: 5173, rest: '/', bare: false });
    expect(previewTarget('/preview/5173')).toEqual({ port: 5173, rest: '/', bare: true });
    expect(previewTarget('/preview/5173?x=1')).toEqual({ port: 5173, rest: '/?x=1', bare: true });
  });
  it('refuses privileged and impossible ports and other paths', () => {
    expect(previewTarget('/preview/80/')).toBeNull();
    expect(previewTarget('/preview/70000/')).toBeNull();
    expect(previewTarget('/preview/abc/')).toBeNull();
    expect(previewTarget('/api/x')).toBeNull();
  });
});

describe('rewriteLocation', () => {
  it('keeps redirects under the prefix', () => {
    expect(rewriteLocation('/login', 3000)).toBe('/preview/3000/login');
    expect(rewriteLocation('/preview/3000/x', 3000)).toBe('/preview/3000/x');
    expect(rewriteLocation('http://localhost:3000/a?b=1', 3000)).toBe('/preview/3000/a?b=1');
    expect(rewriteLocation('http://127.0.0.1:3000/', 3000)).toBe('/preview/3000/');
    expect(rewriteLocation('https://github.com/login', 3000)).toBe('https://github.com/login');
    expect(rewriteLocation('//cdn.example.com/x', 3000)).toBe('//cdn.example.com/x');
    expect(rewriteLocation('relative', 3000)).toBe('relative');
  });
});

describe('forwardCookie', () => {
  it("drops aie-studio's login cookie", () => {
    expect(forwardCookie('ride_session=abc; theme=dark')).toBe('theme=dark');
    expect(forwardCookie('ride_session=abc')).toBeUndefined();
    expect(forwardCookie(undefined)).toBeUndefined();
  });
});

describe('injectIntoHtml', () => {
  const tag = '<script src="/x.js"></script>';
  it('puts the script first in <head>, else after <html>, else first', () => {
    expect(injectIntoHtml('<!doctype html><html><head lang="en"><title>a</title></head></html>', tag)).toBe(`<!doctype html><html><head lang="en">${tag}<title>a</title></head></html>`);
    expect(injectIntoHtml('<html><body>x</body></html>', tag)).toBe(`<html>${tag}<body>x</body></html>`);
    expect(injectIntoHtml('<p>x</p>', tag)).toBe(`${tag}<p>x</p>`);
  });
});

describe('parseLsof', () => {
  it('keeps ports reachable from loopback, once each', () => {
    const out = ['p100', 'cnode', 'n127.0.0.1:5173', 'n[::1]:5173', 'p200', 'cpython3', 'n*:8000', 'p300', 'crapportd', 'n192.168.1.5:7000', 'p400', 'claunchd', 'n*:22'].join('\n');
    expect(parseLsof(out)).toEqual([{ port: 5173, pid: 100, command: 'node' }, { port: 8000, pid: 200, command: 'python3' }]);
  });
});
