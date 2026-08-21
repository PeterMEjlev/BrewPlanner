import { randomUUID } from 'node:crypto';
import type {
  AlertRuleInput,
  CustomAlertRule,
  CustomAlertSignal,
  CustomAlertTest,
} from '@checklist/shared';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { alertRules } from '../db/schema.js';
import { resolveRuleAlerts } from './repo.js';

/**
 * Persistence for the alert rules the brewer writes themselves (the Settings
 * page's Custom alerts card). The evaluator that acts on them lives in
 * notify/custom.ts; this module only stores and returns them.
 *
 * Synchronous (better-sqlite3), like the rest of the repos.
 */

type AlertRuleRow = typeof alertRules.$inferSelect;

const now = (): string => new Date().toISOString();

/**
 * A rule row as the API returns it. `signal` and `test` are stored as JSON, and
 * a row whose JSON no longer parses is dropped from the listing rather than
 * returned in a shape the evaluator would then have to defend against — see
 * {@link listAlertRules}.
 */
function toPublic(row: AlertRuleRow): CustomAlertRule | null {
  try {
    return {
      id: row.id,
      enabled: row.enabled,
      name: row.name,
      signal: JSON.parse(row.signal) as CustomAlertSignal,
      test: JSON.parse(row.test) as CustomAlertTest,
      holdMinutes: row.holdMinutes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Every rule, oldest first — the order the Settings card lists them in, so a
 * rule stays where the brewer last saw it instead of jumping around on edit.
 *
 * A row that no longer parses is skipped. Both JSON columns are written only
 * from a validated schema, so this can't happen short of someone editing the
 * database by hand; skipping keeps one bad row from taking the card down.
 */
export function listAlertRules(): CustomAlertRule[] {
  return db
    .select()
    .from(alertRules)
    .orderBy(asc(alertRules.createdAt), asc(alertRules.id))
    .all()
    .map(toPublic)
    .filter((rule): rule is CustomAlertRule => rule != null);
}

/** The rules the evaluator should be judging this tick. */
export function listEnabledAlertRules(): CustomAlertRule[] {
  return listAlertRules().filter((rule) => rule.enabled);
}

export function getAlertRule(id: string): CustomAlertRule | null {
  const row = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
  return row ? toPublic(row) : null;
}

export function createAlertRule(input: AlertRuleInput): CustomAlertRule {
  const timestamp = now();
  const id = randomUUID();
  db.insert(alertRules)
    .values({
      id,
      enabled: input.enabled,
      name: input.name,
      signal: JSON.stringify(input.signal),
      test: JSON.stringify(input.test),
      holdMinutes: input.holdMinutes,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return getAlertRule(id)!;
}

/**
 * Replace a rule. The whole rule is written, so anything it had open is
 * resolved first: an alert raised by "over 25 °C" would otherwise sit
 * unresolved forever once the rule is rewritten to watch something else, with
 * nothing left that could ever clear it. The condition is judged afresh on the
 * next tick, and re-raises immediately if it is still true.
 */
export function updateAlertRule(id: string, input: AlertRuleInput): CustomAlertRule | null {
  const changes = db
    .update(alertRules)
    .set({
      enabled: input.enabled,
      name: input.name,
      signal: JSON.stringify(input.signal),
      test: JSON.stringify(input.test),
      holdMinutes: input.holdMinutes,
      updatedAt: now(),
    })
    .where(eq(alertRules.id, id))
    .run().changes;
  if (changes === 0) return null;
  resolveRuleAlerts(id);
  return getAlertRule(id);
}

/**
 * Delete a rule, resolving whatever it left open. The alerts themselves stay:
 * they are the record of what the rule caught while it existed, and the Alerts
 * page is a history rather than a view of current configuration.
 */
export function deleteAlertRule(id: string): boolean {
  const gone = db.delete(alertRules).where(eq(alertRules.id, id)).run().changes > 0;
  if (gone) resolveRuleAlerts(id);
  return gone;
}

/** The name a rule is referred to by in the change history. */
export function alertRuleName(id: string): string | null {
  return (
    db.select({ name: alertRules.name }).from(alertRules).where(eq(alertRules.id, id)).get()?.name ??
    null
  );
}
