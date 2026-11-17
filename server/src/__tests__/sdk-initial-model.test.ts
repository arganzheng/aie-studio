import { describe, expect, it } from 'vitest';
import { resolveInitialModel } from '../sdk-session.js';

const catalog = [
  { value: 'default', resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5' },
  { value: 'legacy' },
];

describe('resolveInitialModel', () => {
  it('resolves the default when nothing was requested', () => {
    expect(resolveInitialModel(catalog, '')).toBe('claude-opus-5-5');
    expect(resolveInitialModel(catalog, '  ')).toBe('claude-opus-5-5');
  });
  it('resolves a requested alias to its concrete model', () => {
    expect(resolveInitialModel(catalog, 'sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveInitialModel(catalog, 'claude-opus-5')).toBe('claude-opus-5');
  });
  it('keeps a requested model the catalog does not resolve or know', () => {
    expect(resolveInitialModel(catalog, 'legacy')).toBe('legacy');
    expect(resolveInitialModel(catalog, 'claude-custom-1')).toBe('claude-custom-1');
  });
  it('is null when the default cannot be worked out', () => {
    expect(resolveInitialModel([], '')).toBeNull();
    expect(resolveInitialModel([{ value: 'default' }], '')).toBeNull();
  });
});
