import { describe, expect, it } from 'vitest';
import {
  MAX_ALERTS, alertHeadline, alertKey, alertSessionTitle, dropSeen, isViewing, tabShowsSession, titleWithUnread, upsertAlert,
  type SessionEvent, type ViewState,
} from '../sessionAlerts';

function ev(over: Partial<SessionEvent> = {}): SessionEvent {
  return { id: 'e1', kind: 'done', tabType: 'claude-sdk', projectId: 'p1', sessionId: 's1', title: null, at: 1, ...over };
}
const sdkTab = { id: 't1', type: 'claude-sdk', resumeId: 's1', title: 'Fix rounding' };
const view = (over: Partial<ViewState> = {}): ViewState => ({ attending: true, activeProjectId: 'p1', activeTab: sdkTab, ...over });

describe('upsertAlert', () => {
  it('keeps one alert per session, the newest', () => {
    const a = upsertAlert([ev({ id: 'e1', kind: 'awaiting' })], ev({ id: 'e2', kind: 'done' }));
    expect(a.map((e) => e.id)).toEqual(['e2']);
  });
  it('treats the two Claude tab kinds as one session, Devin as its own', () => {
    expect(upsertAlert([ev({ id: 'e1', tabType: 'session' })], ev({ id: 'e2' }))).toHaveLength(1);
    expect(upsertAlert([ev({ id: 'e1' })], ev({ id: 'e2', tabType: 'devin' }))).toHaveLength(2);
    expect(upsertAlert([ev({ id: 'e1' })], ev({ id: 'e2', projectId: 'p2' }))).toHaveLength(2);
  });
  it('keys a session with no id yet by event', () => {
    expect(alertKey(ev({ id: 'a', sessionId: null }))).not.toBe(alertKey(ev({ id: 'b', sessionId: null })));
  });
  it('caps the list', () => {
    let a: SessionEvent[] = [];
    for (let i = 0; i < MAX_ALERTS + 3; i++) a = upsertAlert(a, ev({ id: `e${i}`, sessionId: `s${i}` }));
    expect(a).toHaveLength(MAX_ALERTS);
    expect(a[0].id).toBe('e3');
  });
});

describe('isViewing', () => {
  it('is true only for the session on screen in a focused page', () => {
    expect(isViewing(ev(), view())).toBe(true);
    expect(isViewing(ev(), view({ attending: false }))).toBe(false);
    expect(isViewing(ev(), view({ activeProjectId: 'p2' }))).toBe(false);
    expect(isViewing(ev({ sessionId: 's2' }), view())).toBe(false);
    expect(isViewing(ev(), view({ activeTab: null }))).toBe(false);
  });
  it('matches a cli-bridge event against an SDK tab, never a Devin tab', () => {
    expect(tabShowsSession(sdkTab, ev({ tabType: 'session' }))).toBe(true);
    expect(tabShowsSession({ ...sdkTab, type: 'devin' }, ev())).toBe(false);
    expect(tabShowsSession({ ...sdkTab, type: 'devin' }, ev({ tabType: 'devin' }))).toBe(true);
    expect(tabShowsSession(sdkTab, ev({ sessionId: null }))).toBe(false);
  });
});

describe('dropSeen', () => {
  it('removes the alert for the session now on screen and keeps the rest', () => {
    const alerts = [ev(), ev({ id: 'e2', sessionId: 's2' })];
    expect(dropSeen(alerts, view()).map((e) => e.id)).toEqual(['e2']);
  });
  it('returns the same array when nothing changes', () => {
    const alerts = [ev({ sessionId: 's2' })];
    expect(dropSeen(alerts, view())).toBe(alerts);
    expect(dropSeen([ev()], view({ attending: false }))).toHaveLength(1);
  });
});

describe('labels', () => {
  it('names the session by tab title, then server title, then kind', () => {
    expect(alertSessionTitle(ev({ title: 'From server' }), [sdkTab])).toBe('Fix rounding');
    expect(alertSessionTitle(ev({ title: 'From server' }), [])).toBe('From server');
    expect(alertSessionTitle(ev(), [])).toBe('Claude session');
    expect(alertSessionTitle(ev({ tabType: 'devin' }), [])).toBe('Devin session');
  });
  it('words the two kinds', () => {
    expect(alertHeadline('done')).toBe('Finished');
    expect(alertHeadline('awaiting')).toBe('Needs your input');
  });
  it('prefixes the unread count to the page title', () => {
    expect(titleWithUnread('demo — AI Studio', 2)).toBe('(2) demo — AI Studio');
    expect(titleWithUnread('demo — AI Studio', 0)).toBe('demo — AI Studio');
  });
});
