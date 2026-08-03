import { eq, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pushTokens } from '../db/schema.js';

/**
 * The registry of phones to push to (see the `push_tokens` table). One row per
 * installed copy of the Android app, owned by the account that registered it.
 *
 * Registration is idempotent by design: the app re-registers on every launch,
 * and FCM rotates tokens on its own schedule, so the same device must not
 * accumulate rows. A token that comes back for a different account moves — the
 * phone now belongs to whoever is signed in on it.
 */

export interface PushTarget {
  token: string;
  userId: number;
}

/** Record (or refresh) a device's token against the signed-in account. */
export function registerPushToken(token: string, userId: number, platform = 'android'): void {
  db.insert(pushTokens)
    .values({ token, userId, platform })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId, platform, lastSeenAt: new Date().toISOString() },
    })
    .run();
}

/** Forget a device — on sign-out, so the next user of that phone isn't pushed to. */
export function unregisterPushToken(token: string): void {
  db.delete(pushTokens).where(eq(pushTokens.token, token)).run();
}

/**
 * Every registered device except those belonging to `exceptUserId` — the actor,
 * who does not need telling what they just did. Pass null (the kiosk, which has
 * no account) to reach everyone.
 */
export function pushTargetsExcept(exceptUserId: number | null): PushTarget[] {
  const rows = exceptUserId == null
    ? db.select({ token: pushTokens.token, userId: pushTokens.userId }).from(pushTokens).all()
    : db
        .select({ token: pushTokens.token, userId: pushTokens.userId })
        .from(pushTokens)
        .where(ne(pushTokens.userId, exceptUserId))
        .all();
  return rows;
}

/** Whether any phone is registered at all — lets the caller skip the work early. */
export function hasPushTargets(): boolean {
  return db.select({ token: pushTokens.token }).from(pushTokens).limit(1).all().length > 0;
}
