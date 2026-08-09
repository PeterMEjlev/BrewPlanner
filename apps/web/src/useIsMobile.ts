import { useEffect, useState } from 'react';

/**
 * True on phone-sized screens (below Tailwind's `md`, where the shell switches to
 * the bottom-nav layout). Drives the compact layouts used by the Android app and
 * the website on a phone; desktop keeps the full command-centre layouts.
 *
 * Shared by the Overview and the Brew System page, which both answer it the same
 * way: skip [FitScale] (nothing is scaled, so the full width is used) and hand
 * the page a locked one-screen height to fill.
 */
export function useIsMobile(): boolean {
  const query = '(max-width: 767px)';
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}
