import { describe, expect, it } from 'vitest';
import { MODES, addPermissionAsk, isSessionMode, modeInfo, parsePermissionAsk, permissionHeadline } from '../sessionMode';

describe('session mode', () => {
  it('offers bypass (first, the default), auto, accept edits and plan', () => {
    expect(MODES.map((m) => m.id)).toEqual(['bypassPermissions', 'auto', 'acceptEdits', 'plan']);
    expect(modeInfo('plan').label).toBe('Plan');
  });
  it('rejects anything else', () => {
    expect(isSessionMode('plan')).toBe(true);
    expect(isSessionMode('auto')).toBe(true);
    expect(isSessionMode('default')).toBe(false);
    expect(isSessionMode(null)).toBe(false);
  });
});

describe('permission asks', () => {
  const frame = { id: 'r1', request: { tool: 'Bash', description: 'List files', detail: 'ls -la', detailKind: 'command', canRemember: true } };
  it('reads a frame and refuses a malformed one', () => {
    expect(parsePermissionAsk(frame)).toEqual({ id: 'r1', request: { tool: 'Bash', description: 'List files', detail: 'ls -la', detailKind: 'command', canRemember: true } });
    expect(parsePermissionAsk({ id: 'r1' })).toBeNull();
    expect(parsePermissionAsk({ id: 1, request: frame.request })).toBeNull();
    expect(parsePermissionAsk({ id: 'r2', request: { tool: 'WebFetch' } })!.request).toEqual({ tool: 'WebFetch', detail: '', detailKind: 'json', canRemember: false });
  });
  it('keeps one card per ask', () => {
    const a = parsePermissionAsk(frame)!;
    const b = parsePermissionAsk({ ...frame, id: 'r2' })!;
    expect(addPermissionAsk(addPermissionAsk([a], b), a).map((x) => x.id)).toEqual(['r2', 'r1']);
  });
  it('names what is asked', () => {
    expect(permissionHeadline(parsePermissionAsk(frame)!.request)).toBe('Claude wants to run a command');
    expect(permissionHeadline({ tool: 'WebFetch', detail: '', detailKind: 'json', canRemember: false })).toBe('Claude wants to use WebFetch');
  });
});
