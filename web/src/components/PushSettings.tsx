import { useCallback, useEffect, useMemo, useState } from 'react';
import { currentPushSupport, currentSubscription, disablePush, enablePush, listPushDevices, testPush, type PushDevice } from '../lib/push';

// Model: server.WebPush — Settings → Features → Push notifications: turn
// pushes on for this device, send a test, see (and drop) the devices that
// get them.

const SUPPORT_HINT: Record<string, string> = {
  insecure: 'Not available on this address: push needs HTTPS (or localhost).',
  'ios-home-screen': 'On iPhone / iPad, add aie-studio to the Home Screen (Share → Add to Home Screen), open it from there, then turn this on.',
  unsupported: 'This browser does not support push notifications.',
};

function when(ts: number | null): string {
  if (!ts) return 'not reached yet';
  return `last reached ${new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export function PushSettings() {
  const support = useMemo(currentPushSupport, []);
  const [mine, setMine] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const sub = await currentSubscription().catch(() => null);
    setMine(sub?.endpoint ?? null);
    setDevices(await listPushDevices());
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const on = !!mine && devices.some((d) => d.endpoint === mine);
  const run = async (what: () => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try { setNote(await what()); }
    catch (e) { setNote(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); void refresh(); }
  };

  return (
    <div className="settings-section push-settings">
      <div className="settings-label">Push notifications</div>
      <label className="settings-option">
        <input
          type="checkbox"
          checked={on}
          disabled={busy || support !== 'ok'}
          onChange={(e) => void run(async () => {
            if (e.target.checked) { await enablePush(); return 'This device will get alerts even when aie-studio is closed.'; }
            await disablePush();
            return null;
          })}
        />
        <div className="settings-option-text">
          <div>Send alerts to this device, even when aie-studio is closed</div>
          <div className="settings-option-hint">
            {support !== 'ok'
              ? SUPPORT_HINT[support]
              : 'The server pushes every "finished" and "needs you" alert to each device turned on here, page open or not. Turn it on once per device.'}
          </div>
        </div>
      </label>
      {on && (
        <div className="settings-sub">
          <button
            type="button"
            className="push-test"
            disabled={busy}
            onClick={() => void run(async () => {
              const r = await testPush();
              return r.sent ? 'Test sent — it should appear in a few seconds.' : r.removed ? 'The push service no longer knows this device; turn push on again.' : 'Sending failed; see the server log.';
            })}
          >Send a test</button>
        </div>
      )}
      {note && <div className="settings-option-hint push-note">{note}</div>}
      {devices.length > 0 && (
        <ul className="push-devices">
          {devices.map((d) => (
            <li key={d.endpoint}>
              <span>{d.label}{d.endpoint === mine ? ' (this device)' : ''}</span>
              <span className="push-device-when">{when(d.lastOkAt)}</span>
              <button
                type="button"
                title="Stop pushing to this device"
                aria-label={`Remove ${d.label}`}
                disabled={busy}
                onClick={() => void run(async () => {
                  if (d.endpoint === mine) { await disablePush(); return null; }
                  await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: d.endpoint }) });
                  return null;
                })}
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
