import type { SessionEventKind } from './sessionAlerts';

// Model: web.SessionAlerts — the two side channels of an alert: a short chime
// and an OS-level notification (for when the page is in the background).

let audioCtx: AudioContext | null = null;

// Two soft notes, rising for "finished", repeated for "needs your input".
// Synthesised so there is no asset to ship. Browsers only let a page make
// sound after the user has interacted with it; before that this is a no-op.
export function playChime(kind: SessionEventKind): void {
  try {
    const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const notes = kind === 'awaiting' ? [880, 880] : [660, 880];
    notes.forEach((freq, i) => {
      const t0 = ctx.currentTime + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.15);
    });
  } catch {}
}

export type SystemNotifyState = 'granted' | 'default' | 'denied' | 'unsupported';

// 'unsupported' covers plain-HTTP origins (the Notification API needs a
// secure context) and iOS Safari outside an installed home-screen app.
export function systemNotifyState(): SystemNotifyState {
  if (typeof Notification === 'undefined' || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

// Must run inside a click handler: browsers ignore permission prompts that
// aren't triggered by the user.
export async function requestSystemNotify(): Promise<SystemNotifyState> {
  if (systemNotifyState() === 'unsupported') return 'unsupported';
  try { await Notification.requestPermission(); } catch {}
  return systemNotifyState();
}

// `data` rides along so a click can open the session. With a service worker
// (production build) the notification is shown through it — the only way
// that works on Android and installed iOS apps — and the click comes back as
// a 'session-alert-open' message; otherwise `onClick` fires directly.
export async function showSystemNotification(
  opts: { title: string; body: string; tag: string; data: unknown },
  onClick: () => void,
): Promise<void> {
  if (systemNotifyState() !== 'granted') return;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg?.active) {
      await reg.showNotification(opts.title, { body: opts.body, tag: opts.tag, data: opts.data, icon: '/icon.svg' });
      return;
    }
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, icon: '/icon.svg' });
    n.onclick = () => { window.focus(); n.close(); onClick(); };
  } catch {}
}
