/**
 * What a change actually changed, in words.
 *
 * The audit hook's rules turn a request into one sentence, and that sentence is
 * used twice: it's the line on the History page, and it's the body of the push
 * that lands on the other brewers' phones. A phone showing "Updated graph
 * colours" tells nobody anything — the notification has one line to earn being
 * an interruption, so these helpers spend it on the specifics: which setting,
 * from what to what, which part of the sheet.
 *
 * Most of the settings routes save the whole object every time, so "what
 * changed" only exists as a diff against the state the pre-handler snapshotted.
 * Everything here is total: a snapshot that's missing or unparseable degrades to
 * a vaguer sentence rather than throwing into the hook that logs it.
 */

/** A field of a saved-whole settings object, and how to say it out loud. */
export interface FieldLabel<T> {
  key: keyof T & string;
  /** How the field is named in the sentence — "the gravity graph colour". */
  label: string;
  /** Renders a value for the sentence. Omit for fields named without a value. */
  value?: (value: unknown) => string | null;
}

/** Read a plain object, or null when it isn't one. */
function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The fields whose value differs between the snapshot and what was just saved.
 * An absent or unreadable snapshot yields an empty list — the caller's cue to
 * fall back to a general sentence rather than to claim nothing changed.
 */
export function changedFields<T>(
  before: unknown,
  after: unknown,
  fields: readonly FieldLabel<T>[],
): FieldLabel<T>[] {
  const from = asObject(before);
  const to = asObject(after);
  if (!from || !to) return [];
  return fields.filter((field) => {
    if (!(field.key in to)) return false;
    // JSON rather than `!==` so a nested value (a colour map's entry) compares
    // by content; these objects are small and flat enough for it to be honest.
    return JSON.stringify(from[field.key]) !== JSON.stringify(to[field.key]);
  });
}

/**
 * "the keg alert threshold to 21 days and fermentation-done alerts off" — the
 * changed fields as one readable clause, capped so a notification stays a line
 * rather than becoming a changelog.
 */
export function describeChanges<T>(
  changed: readonly FieldLabel<T>[],
  after: unknown,
  max = 3,
): string | null {
  const to = asObject(after);
  if (!to || changed.length === 0) return null;
  const parts = changed.slice(0, max).map((field) => {
    const rendered = field.value ? field.value(to[field.key]) : null;
    return rendered ? `${field.label} to ${rendered}` : field.label;
  });
  const rest = changed.length - parts.length;
  const list =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return rest > 0 ? `${list} (+${rest} more)` : list;
}

/** An on/off field, said the way a person would say it. */
export const onOff = (value: unknown): string => (value === true ? 'on' : 'off');

/** A number with its unit, or null when the value isn't one. */
export function withUnit(unit: string, decimals = 0): (value: unknown) => string | null {
  return (value) =>
    typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(decimals)} ${unit}` : null;
}

/** A colour, quoted as its hex so "changed to what?" has an answer. */
export const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

// --- Kegs -------------------------------------------------------------------

/**
 * The sheet's marker for a keg with nothing in it. Written by the desktop
 * editor's "empty" option, so a keg being emptied is worth saying as such
 * rather than as "set to ???".
 */
const EMPTY_KEG = '???';

/**
 * What a keg write did, from the body alone. The inventory lives in a Google
 * Sheet, so the previous contents would cost a network round trip inside a hook
 * that must stay synchronous — the new state is therefore stated in full
 * instead of as a transition, which is what a phone wants to read anyway.
 */
export function describeKegWrite(
  number: string,
  fields: { contents?: string; abv?: string; date?: string; note?: string },
): string {
  const keg = `keg #${number}`;
  const contents = fields.contents?.trim() ?? '';
  if (!contents || contents === EMPTY_KEG) return `Emptied ${keg}`;

  const detail = [
    fields.abv?.trim() ? `${fields.abv.trim().replace(/%$/, '')}%` : '',
    fields.date?.trim() ? `filled ${fields.date.trim()}` : '',
    fields.note?.trim() ? `“${fields.note.trim()}”` : '',
  ].filter(Boolean);
  return `Put "${contents}" in ${keg}${detail.length > 0 ? ` — ${detail.join(', ')}` : ''}`;
}

// --- Recipes ----------------------------------------------------------------

/**
 * Which parts of a brew sheet an edit touched. "Edited recipe X" is true of
 * every save, including the one that changed a single hop addition; naming the
 * sections is the difference between a notification worth opening and one worth
 * swiping away.
 *
 * Grouped the way the sheet is read rather than field by field: a brewer cares
 * that the hops moved, not that `hops[2].time` did.
 */
const RECIPE_SECTIONS: { label: string; keys: string[] }[] = [
  { label: 'the name', keys: ['name'] },
  { label: 'the style', keys: ['style'] },
  { label: 'the targets', keys: ['og', 'fg', 'abv', 'ibu', 'ebc', 'preBoilGravity', 'postBoilGravity'] },
  { label: 'the batch size', keys: ['batchSizeL'] },
  { label: 'the grain bill', keys: ['fermentables'] },
  { label: 'the hops', keys: ['hops'] },
  { label: 'the yeast', keys: ['yeast'] },
  { label: 'other ingredients', keys: ['otherIngredients'] },
  { label: 'the mash', keys: ['mashGuidelines', 'mashTemp'] },
  { label: 'the water profile', keys: ['waterProfile'] },
  { label: 'the fermentation temperature', keys: ['fermentationTemp'] },
];

/** The sections that differ between the stored sheet and the one just saved. */
export function changedRecipeSections(before: unknown, after: unknown): string[] {
  const from = asObject(before);
  const to = asObject(after);
  if (!from || !to) return [];
  return RECIPE_SECTIONS.filter((section) =>
    section.keys.some(
      (key) => key in to && JSON.stringify(from[key]) !== JSON.stringify(to[key]),
    ),
  ).map((section) => section.label);
}

/** "the hops, the water profile and 2 more" — sections as one clause. */
export function joinSections(sections: readonly string[], max = 3): string | null {
  if (sections.length === 0) return null;
  const shown = sections.slice(0, max);
  const rest = sections.length - shown.length;
  const list =
    shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`;
  return rest > 0 ? `${list} (+${rest} more)` : list;
}
