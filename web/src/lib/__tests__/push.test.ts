import { describe, expect, it } from 'vitest';
import { alertFromHash, deviceLabel, pushSupport } from '../push';

const ok = { secure: true, sw: true, push: true, notification: true, ios: false, standalone: false };

describe('pushSupport', () => {
  it('needs a secure page, and the Home Screen app on iOS', () => {
    expect(pushSupport(ok)).toBe('ok');
    expect(pushSupport({ ...ok, secure: false })).toBe('insecure');
    expect(pushSupport({ ...ok, ios: true })).toBe('ios-home-screen');
    expect(pushSupport({ ...ok, ios: true, standalone: true })).toBe('ok');
    expect(pushSupport({ ...ok, push: false })).toBe('unsupported');
  });
});

describe('deviceLabel', () => {
  it('names the device and browser', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Mac · Chrome');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabel('curl/8')).toBe('Device');
  });
});

describe('alertFromHash', () => {
  it('reads the alert a notification click passed in', () => {
    const e = { projectId: 'p', sessionId: 's', kind: 'done' };
    expect(alertFromHash(`#alert=${encodeURIComponent(JSON.stringify(e))}`)).toEqual(e);
    expect(alertFromHash('#other')).toBeNull();
    expect(alertFromHash('#alert=%7Bbad')).toBeNull();
  });
});
