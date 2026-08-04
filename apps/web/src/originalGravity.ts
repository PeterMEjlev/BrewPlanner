import { useEffect, useState } from 'react';
import { api } from './api';
import { loadRecipeDetail } from './recipeStore';

/**
 * The OG the beer in the fermenter actually started at — what the live
 * attenuation and ABV on the Overview's Gravity card are measured against.
 *
 * Three sources, best first, because the honest number and the available number
 * are rarely the same one:
 *
 * 1. what the brewer measured on brew day, off the batch's own log entry;
 * 2. the target the recipe carried the day it was brewed (the log's snapshot),
 *    for a batch whose OG hasn't been typed in yet;
 * 3. the recipe's target as it reads today, for a beer put in the fermenter
 *    without a brew session behind it.
 *
 * `measured` says which kind it is, so the card can label an estimate as one
 * rather than quietly presenting a hope as a measurement.
 */
export interface OriginalGravity {
  value: number;
  /** True only for source 1 — a gravity someone actually took. */
  measured: boolean;
}

/**
 * Read the OG of whatever `recipeId` currently has in the tank.
 *
 * Deliberately uncached: a brewer types the measured OG into the log hours after
 * pitching, and a value cached for the life of the tab would keep the card on
 * the recipe's target until a reload. One small request per visit instead.
 */
export function useOriginalGravity(recipeId: string | null): OriginalGravity | null {
  const [og, setOg] = useState<OriginalGravity | null>(null);

  useEffect(() => {
    if (recipeId == null) {
      setOg(null);
      return;
    }
    let live = true;
    void readOriginalGravity(recipeId).then((value) => {
      if (live) setOg(value);
    });
    return () => {
      live = false;
    };
  }, [recipeId]);

  return og;
}

async function readOriginalGravity(recipeId: string): Promise<OriginalGravity | null> {
  // Newest first, so the batch in the tank is the most recent one not yet
  // packaged — falling back to the newest of all for a recipe whose batches have
  // all been packaged but which is still marked as the active one.
  const sessions = await api.listRecipeBrewSessions(recipeId).catch(() => []);
  const batch = sessions.find((s) => s.status !== 'packaged') ?? sessions[0];

  const measured = parseGravity(batch?.measured.og);
  if (measured != null) return { value: measured, measured: true };

  const snapshot = parseGravity(batch?.recipe.og);
  if (snapshot != null) return { value: snapshot, measured: false };

  const recipe = await loadRecipeDetail(recipeId).catch(() => null);
  const target = parseGravity(recipe?.og);
  return target == null ? null : { value: target, measured: false };
}

/**
 * A gravity figure as the brew sheet holds it — free text, so anything that
 * isn't a plausible original gravity is treated as nothing rather than fed to
 * the arithmetic. The bounds are wide enough for any beer and narrow enough to
 * reject a stray "1" or a Plato figure typed in the wrong box.
 */
function parseGravity(text: string | undefined): number | null {
  if (!text) return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) && value > 1 && value < 1.25 ? value : null;
}
