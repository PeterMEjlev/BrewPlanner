import { useEffect, useState } from 'react';

/** The Pi's DSI touchscreen: a 7" panel at 800×480 px, landscape. */
const KIOSK_W = 800;
const KIOSK_H = 480;

function isOversize(): boolean {
  // The physical kiosk launches with ?kiosk=1 → <html class="kiosk"> (see
  // main.tsx). Never letterbox the real device, whatever it reports as its size.
  if (document.documentElement.classList.contains('kiosk')) return false;
  return window.innerWidth > KIOSK_W || window.innerHeight > KIOSK_H;
}

/**
 * Pins the kiosk views to the touchscreen's exact 800×480 px box so a change
 * looks the same in a desktop browser as it does on the Pi.
 *
 * On the device itself the viewport *is* 800×480, so this is a transparent
 * pass-through and the kiosk fills the screen exactly as before. On a larger
 * monitor (a laptop while developing) it instead letterboxes a true-to-life
 * 800×480 frame — centred, real pixel size, never upscaled — so the preview
 * matches the hardware rather than stretching to fill the bigger window.
 */
export function KioskFrame({ children }: { children: React.ReactNode }): JSX.Element {
  const [oversize, setOversize] = useState(isOversize);

  useEffect(() => {
    const onResize = (): void => setOversize(isOversize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // On the Pi (viewport ≤ 800×480) stay out of the way entirely.
  if (!oversize) return <>{children}</>;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-auto bg-zinc-900 p-4">
      <div className="shrink-0 text-xs font-medium uppercase tracking-wider text-zinc-500">
        Kiosk preview · {KIOSK_W} × {KIOSK_H}
      </div>
      {/* Fixed device-sized box: children lay out against its definite height,
          so their h-full / flex-1 resolve to the real 480 px just like on the Pi. */}
      <div
        className="shrink-0 overflow-hidden ring-1 ring-zinc-700 shadow-2xl shadow-black/60"
        style={{ width: KIOSK_W, height: KIOSK_H }}
      >
        {children}
      </div>
    </div>
  );
}
