import { describe, expect, it } from 'vitest';
import { ago, cycleTab, score, search, terms, type PaletteItem } from '../palette';

const s = (id: string, title: string, detail = '', updatedAt = 0): PaletteItem => ({ id, group: 'Sessions', title, detail, updatedAt });

describe('search', () => {
  const items: PaletteItem[] = [
    s('a', 'Fix login bug', 'aie-studio · 2h ago', 10),
    s('b', 'Login page redesign', 'blog · 1d ago', 30),
    s('c', 'Deploy notes', 'aie-studio · archived', 20),
    { id: 'x', group: 'Actions', title: 'New Claude session', detail: '' },
    { id: 'p', group: 'Projects', title: 'aie-studio', detail: '~/Code/aie-studio' },
  ];

  it('needs every term, title matches first', () => {
    expect(search(items, 'login').map((i) => i.id)).toEqual(['b', 'a']);
    expect(search(items, 'login aie').map((i) => i.id)).toEqual(['a']);
    expect(search(items, 'archived').map((i) => i.id)).toEqual(['c']);
  });

  it('groups actions, projects, sessions; empty query lists sessions newest first', () => {
    expect(search(items, '').map((i) => i.id)).toEqual(['x', 'p', 'b', 'c', 'a']);
    expect(search(items, 'aie').map((i) => i.group)).toEqual(['Projects', 'Sessions', 'Sessions']);
  });

  it('caps the sessions shown', () => {
    expect(search(items, '', 1).filter((i) => i.group === 'Sessions').map((i) => i.id)).toEqual(['b']);
  });

  it('scores a title that starts with the query highest', () => {
    expect(score(s('1', 'Login page'), terms('login'))).toBeGreaterThan(score(s('2', 'Fix login'), terms('login'))!);
    expect(score(s('3', 'x', 'y'), terms('z'))).toBeNull();
  });
});

describe('cycleTab', () => {
  it('wraps round both ways', () => {
    expect(cycleTab(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycleTab(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(cycleTab(['a', 'b', 'c'], 'b', 1)).toBe('c');
  });
  it('starts at an end when nothing is active, and goes nowhere with one tab', () => {
    expect(cycleTab(['a', 'b'], null, -1)).toBe('b');
    expect(cycleTab(['a'], 'a', 1)).toBeNull();
    expect(cycleTab([], null, 1)).toBeNull();
  });
});

describe('ago', () => {
  it('rounds to a short unit', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 5 * 60_000)).toBe('5m ago');
    expect(ago(0, 3 * 3600_000)).toBe('3h ago');
    expect(ago(0, 72 * 3600_000)).toBe('3d ago');
  });
});
