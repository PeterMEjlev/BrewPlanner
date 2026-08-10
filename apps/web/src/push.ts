import { Preferences } from '@capacitor/preferences';
import { api } from './api';
import { isNative } from './native';

/**
 * Push notifications in the Android app: getting this phone a Firebase token and
 * handing it to the hub, which then announces other people's changes to it (see
 * the server's notify/push.ts).
 *
 * Nothing here runs in the browser — a web page has no FCM token — so every
 * entry point is a no-op off-native, and the plugin is imported lazily so the
 * browser bundle never carries it.
 *
 * Registration is attempted once per app run, after the session resolves: the
 * hub stores the token against the signed-in account, which is what lets it
 * leave you out of announcements about your own edits. FCM may hand back a
 * *different* token at any launch (it rotates them), so re-registering every
 * time is the intended pattern rather than a wasted call.
 *
 * A phone that declines the notification permission simply never registers.
 * That's a supported state, not an error to nag about: the app is fully usable
 * without it, and Android will not ask twice anyway.
 */

/**
 * The Android channels the hub's messages are posted to, created on first run —
 * Android 8+ silently drops a notification aimed at a channel that doesn't
 * exist, and these ids must match the ones in the server's notify/push.ts.
 *
 * There are two because the messages are not alike. Someone renaming a keg can
 * wait; the fermenter losing its seal at 3am cannot, and only a separate channel
 * lets the person holding the phone mute the first without losing the second.
 * The critical one asks for MAX importance so Android heads-up displays it.
 */
const CHANGES_CHANNEL = {
  id: 'konfus-changes',
  name: 'Brewery changes',
  description: 'When someone else changes something in the brewery',
  importance: 4 as const,
};
const CRITICAL_CHANNEL = {
  id: 'konfus-critical',
  name: 'Brewery alerts',
  description: 'Pressure, temperature and sensor problems that need attention now',
  importance: 5 as const,
};

/**
 * The last token handed to the hub, kept so sign-out can withdraw it — by then
 * the plugin may have moved on, and an un-withdrawn token would keep buzzing
 * this phone with the previous user's notifications.
 */
const TOKEN_KEY = 'konfus.pushToken';

/** Set once per app run, so a re-render doesn't re-register on every auth refresh. */
let started = false;

/** Where a tapped notification should navigate to. Wired up by main.tsx. */
let openHandler: ((path: string) => void) | null = null;

/** Register the router navigation a notification tap uses (see main.tsx). */
export function setPushOpenHandler(handler: (path: string) => void): void {
  openHandler = handler;
}

/**
 * Ask for permission, get a token, and give it to the hub. Safe to call often —
 * it does its work once. Never throws: push is a nicety, and a phone that can't
 * register should still show the brewery.
 */
export async function ensurePushRegistered(): Promise<void> {
  if (!isNative() || started) return;
  started = true;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    // Android 8+ drops notifications posted to a channel that doesn't exist.
    // Creating one that already exists is a no-op, and importance is the
    // phone's to change afterwards — this only sets what it starts at.
    for (const channel of [CHANGES_CHANNEL, CRITICAL_CHANNEL]) {
      await PushNotifications.createChannel({ ...channel, visibility: 1 }).catch(() => {});
    }

    // Android 13+ prompts here; older versions resolve granted straight away.
    let status = await PushNotifications.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
      status = await PushNotifications.requestPermissions();
    }
    if (status.receive !== 'granted') return;

    await PushNotifications.addListener('registration', (token) => {
      void (async () => {
        try {
          await api.registerPushToken(token.value);
          await Preferences.set({ key: TOKEN_KEY, value: token.value });
        } catch {
          // The hub was unreachable. The next launch registers again.
        }
      })();
    });

    await PushNotifications.addListener('registrationError', () => {
      // Almost always a missing google-services.json in the build. Nothing the
      // person holding the phone can do, so it stays out of their way.
    });

    // Tapping a notification opens the page the change was on.
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const path = action.notification.data?.path;
      if (typeof path === 'string' && path.startsWith('/')) openHandler?.(path);
    });

    await PushNotifications.register();
  } catch {
    // No Firebase in this build, or the plugin is unavailable: stay quiet.
  }
}

/**
 * Withdraw this phone on sign-out, so the next person to use it doesn't inherit
 * the last one's notifications. Best-effort: an unreachable hub still signs out.
 */
export async function unregisterPush(): Promise<void> {
  if (!isNative()) return;
  started = false;
  try {
    const stored = await Preferences.get({ key: TOKEN_KEY });
    if (stored.value) {
      await api.unregisterPushToken(stored.value).catch(() => {});
      await Preferences.remove({ key: TOKEN_KEY });
    }
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.removeAllListeners().catch(() => {});
  } catch {
    // Nothing to withdraw.
  }
}
