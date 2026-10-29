/** Small browser helpers: downloads, clipboard, wake lock, QR codes. */
import { useEffect } from 'preact/hooks';
import { renderSVG } from 'uqr';

export function downloadText(filename: string, body: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: 'M', border: 2, pixelSize: 8, blackColor: '#000000', whiteColor: '#ffffff' });
}

/** Keep the screen on while `active` (phones dim mid-lecture otherwise). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
        if (cancelled) await lock?.release();
      } catch {
        // Battery saver or unsupported: not fatal.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}

/** Reconnect promptly when the network comes back or the tab is shown again. */
export function useReconnectNudges(nudge: () => void): void {
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && nudge();
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [nudge]);
}

export function safeFilename(s: string): string {
  return s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'captions';
}
