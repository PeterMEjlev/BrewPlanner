import {
  applyRecipeCalculations,
  aromaHopRate,
  calculateRecipe,
  DEFAULT_RECIPE_SETTINGS,
  ebcColor,
  estimateFermentablePpg,
  estimateFermentationDays,
  getRecipeColor,
  HOP_STAGE_ORDER,
  isFermentableLine,
  missingStatInput,
  withAutoBoilVolumes,
  withLeadingZero,
} from '@checklist/shared';
import type {
  CostTotal,
  HopStage,
  RecipeCostBreakdown,
  RecipeDefaults,
  RecipeDetail,
  RecipeEditInput,
  RecipeFermentableEdit,
  RecipeHopEdit,
  RecipeMashStep,
  RecipeOtherIngredientEdit,
  RecipeSettings,
  RecipeStatKey,
  RecipeWaterProfile,
  SavedWaterProfile,
  RecipeYeastEdit,
  RecipeYeastSpec,
  UnpricedIngredient,
} from '@checklist/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { kr } from '../money';
import { TARGET_PRESETS } from '../water';
import {
  ALL_STYLE_CATEGORIES,
  ALL_SUBSTYLES,
  BATCH_TARGETS,
  categoryIsStyle,
  COUNT_UNITS,
  DEFAULT_STYLE_CATEGORIES,
  FLOCCULATION_OPTIONS,
  HOP_FORMS,
  isKnownStyleCategory,
  MASH_TYPES,
  OTHER_TYPES,
  OTHER_USES,
  PITCH_RATES,
  substylesFor,
  VOLUME_UNITS,
  WATER_SOURCES,
  WEIGHT_UNITS,
  YEAST_FORMS,
} from '../recipeCatalog';
import type { StyleChoice } from '../recipeCatalog';
import { useRecipeDefaults } from '../recipeDefaults';
import { setSetting, useSettings } from '../settings';
import { rangeForStyle } from '../styleRanges';
import { useKegContentColors } from '../kegContentColors';
import { IngredientSearchSelect, SearchableSelect } from './SearchableSelect';
import { Select } from './Select';
import { SheetSection } from './SheetSection';
import { UnpricedIngredientsDialog } from './UnpricedIngredients';

interface Props {
  recipe: RecipeDetail;
  saving: boolean;
  error: string | null;
  onSave: (recipe: RecipeEditInput) => Promise<void>;
  onCancel: () => void;
  /**
   * Offer only what the shop sells in the ingredient pickers, leaving out the
   * names past recipes have used. Set when a recipe is being written from
   * scratch: a blank sheet should be filled from the catalogue, which is what
   * can be priced and ordered — an old sheet's freehand wording is neither.
   *
   * Doubles as the "this is a blank sheet" signal for which sections open
   * expanded — see {@link NEW_RECIPE_COLLAPSED} — since the two only ever
   * happen together in practice.
   */
  catalogueOnly?: boolean;
}

/**
 * The three ingredient lists whose rows fill themselves in from the catalogue,
 * and so have something worth locking. Mash steps and "other ingredients" are
 * typed from scratch, so they have no lock.
 *
 * The lock covers what the catalogue vouched for — the colour, the extract
 * potential, the alpha acid, the attenuation — and deliberately not how much of
 * the ingredient goes in. A weight is the brewer's to type, and picking the
 * ingredient is usually the step immediately before typing it.
 */
type LockedLines = 'fermentables' | 'hops' | 'yeast';

/**
 * The editor's own panels, folded away one at a time like the recipe page's are.
 * Kept under a separate key from the reading sheet: which sections a brewer
 * wants open to *write* a recipe isn't the same question as which they want open
 * to brew from it.
 */
type EditorSectionKey =
  | 'setup'
  | 'fermentables'
  | 'hops'
  | 'yeast'
  | 'other'
  | 'mash'
  | 'water'
  | 'notes';

const COLLAPSE_KEY = 'brewplanner.recipeEditorSections';

/**
 * Every section opens expanded — a recipe being built is a form to fill in, and
 * a form that starts folded up hides what still needs answering. Folding one
 * away is then remembered, the same as on the recipe page.
 */
const ALL_OPEN: Record<EditorSectionKey, boolean> = {
  setup: false,
  fermentables: false,
  hops: false,
  yeast: false,
  other: false,
  mash: false,
  water: false,
  notes: false,
};

/**
 * How a blank sheet opens instead: every ingredient section is empty at this
 * point, so expanding all seven is seven empty lists to scroll past before
 * reaching the one field — the style, the batch size — actually worth setting
 * first. Recipe setup stays open for that; the rest unfold as the brewer fills
 * them in, same as ever.
 */
const NEW_RECIPE_COLLAPSED: Record<EditorSectionKey, boolean> = {
  ...ALL_OPEN,
  fermentables: true,
  hops: true,
  yeast: true,
  other: true,
  mash: true,
  water: true,
  notes: true,
};

/**
 * `isNew` skips the remembered layout rather than merely seeding it: the point
 * is a blank sheet opening the same way every time, not the *first* blank sheet
 * doing so and every one after inheriting whatever was left expanded by the
 * last recipe worked on.
 */
function loadCollapsed(isNew: boolean): Record<EditorSectionKey, boolean> {
  if (isNew) return NEW_RECIPE_COLLAPSED;
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (!raw) return ALL_OPEN;
    return { ...ALL_OPEN, ...(JSON.parse(raw) as Partial<Record<EditorSectionKey, boolean>>) };
  } catch {
    return ALL_OPEN;
  }
}

function rememberCollapsed(next: Record<EditorSectionKey, boolean>): Record<EditorSectionKey, boolean> {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  } catch {
    // Per-browser convenience only.
  }
  return next;
}

/**
 * The contents rail beside the sheet, in the order the sections are laid out.
 * The statistics aren't in it: they are a readout rather than a section to fill
 * in, and they are either already on screen beside the sheet or sitting at the
 * top of it.
 *
 * Labels are the rail's own rather than the section headings': a heading has
 * the width of the sheet to explain itself in, and "Other ingredients"
 * truncated to fit an 11rem rail says less than "Other" does.
 */
const SECTION_RAIL: Array<{ key: EditorSectionKey; icon: string; label: string }> = [
  { key: 'setup', icon: '📋', label: 'Recipe setup' },
  { key: 'fermentables', icon: '🌾', label: 'Fermentables' },
  { key: 'hops', icon: '🌿', label: 'Hops' },
  { key: 'yeast', icon: '🧫', label: 'Yeast' },
  { key: 'other', icon: '🧪', label: 'Other' },
  { key: 'mash', icon: '🌡️', label: 'Mash guidelines' },
  { key: 'water', icon: '💧', label: 'Water chemistry' },
  { key: 'notes', icon: '📝', label: 'Notes' },
];

/** Where the rail's links land, and what the position marker measures. */
function sectionAnchor(key: EditorSectionKey): string {
  return `recipe-section-${key}`;
}

/**
 * How far down the page the "you are here" line sits, in pixels. A section
 * counts as the one being worked on once its header has scrolled to within this
 * much of the top; on the line itself, a section would only light up its entry
 * after its header had left the screen entirely.
 */
const SECTION_LINE_PX = 96;

/** Breathing room left above a section the rail has just jumped to. */
const SECTION_SCROLL_MARGIN_PX = 12;

/**
 * Which section the sheet is scrolled to, so the rail doubles as a position
 * marker rather than only a set of links.
 *
 * Measured on scroll rather than with an IntersectionObserver, the same way the
 * library reader's contents follow the reading position: "the last header above
 * the line" is one pass over eight elements and says exactly what it means.
 * Coalesced onto animation frames so a fast scroll measures once per paint, and
 * re-measured whenever `layout` changes — folding a section away moves every
 * section under it without scrolling the page at all.
 */
function useSectionInView(layout: unknown, landed: SectionLanding | null): EditorSectionKey | null {
  const [here, setHere] = useState<EditorSectionKey | null>(null);
  useEffect(() => {
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      // Sitting exactly where a rail jump left the page: the section that was
      // asked for is a better answer than any measurement — see SectionLanding.
      if (landed && Math.abs(window.scrollY - landed.y) <= 2) {
        setHere(landed.key);
        return;
      }
      // At the foot of the page the last sections can never reach the line —
      // the page runs out of scroll while they are still halfway down the
      // screen — so scrolling to the bottom means the last section, or the rail
      // would never light up the water chemistry it ends on.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
        setHere(SECTION_RAIL[SECTION_RAIL.length - 1]?.key ?? null);
        return;
      }
      let current: EditorSectionKey | null = null;
      // In document order, so the last one to start above the line is the one
      // being worked on.
      for (const { key } of SECTION_RAIL) {
        const header = document.getElementById(sectionAnchor(key));
        if (header && header.getBoundingClientRect().top <= SECTION_LINE_PX) current = key;
      }
      // Above the first header — which is where the page opens — the first
      // section is still the one in front of you.
      setHere(current ?? SECTION_RAIL[0]?.key ?? null);
    };
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    measure();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [layout, landed]);
  return here;
}

/**
 * Where a rail jump left the page, and which section it was asked for.
 *
 * While the page is still sitting on that exact spot, the click outranks the
 * measured position. It has to: the last few sections share the screen at the
 * foot of the sheet and none of them can be brought to the marker line, so
 * "mash guidelines" and "water chemistry" are the same scroll position and only
 * the click tells them apart. Any real scroll moves the page off the spot and
 * hands the answer back to the measurement.
 */
interface SectionLanding {
  key: EditorSectionKey;
  /** Scroll position the jump settled on, already clamped to the page. */
  y: number;
}

const fieldClass =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-[#f06a5c] focus:ring-1 focus:ring-[#f06a5c]/40';

/**
 * A stored recipe as the editor's draft. Figures arrive already tidied — a
 * sheet is read back through `recipeEditSchema`, which supplies a missing
 * leading zero on the way out as well as in — so nothing here has to repeat
 * that rule; the live one is on {@link Field}, for figures being typed now.
 */
function editable(recipe: RecipeDetail): RecipeEditInput {
  return {
    name: recipe.name,
    style: recipe.style,
    notes: recipe.notes,
    settings: { ...DEFAULT_RECIPE_SETTINGS, ...recipe.settings },
    og: recipe.og,
    preBoilGravity: recipe.preBoilGravity,
    postBoilGravity: recipe.postBoilGravity,
    fg: recipe.fg,
    abv: recipe.abv,
    ibu: recipe.ibu,
    ebc: recipe.ebc,
    ebcEstimated: recipe.ebcEstimated,
    batchSizeL: recipe.batchSizeL,
    mashTemp: recipe.mashTemp,
    fermentationTemp: recipe.fermentationTemp,
    fermentables: recipe.fermentables.map(({ grams: _grams, price: _price, ...line }) => ({
      ...line,
      amount: fermentableAmountKg(line.amount, line.unit),
      unit: 'kg',
      ppg: line.ppg ?? null,
    })),
    hops: recipe.hops.map(({ grams: _grams, price: _price, ...line }) => ({
      ...line,
      form: line.form || 'Pellet',
      utilization: line.utilization || '',
    })),
    yeast: recipe.yeast.map(({ grams: _grams, units: _units, price: _price, ...line }) => line),
    otherIngredients: recipe.otherIngredients.map(
      ({ grams: _grams, units: _units, price: _price, ...line }) => ({
        ...line,
        timeUnit: line.timeUnit || '',
      }),
    ),
    mashGuidelines: recipe.mashGuidelines
      ? {
          startingThicknessLPerKg: recipe.mashGuidelines.startingThicknessLPerKg ?? null,
          grainTempC: recipe.mashGuidelines.grainTempC ?? null,
          autoStrikeVolume: recipe.mashGuidelines.autoStrikeVolume ?? false,
          steps: recipe.mashGuidelines.steps.map(normalizeMashStep),
          notes: recipe.mashGuidelines.notes,
        }
      : null,
    waterProfile: recipe.waterProfile ? { ...recipe.waterProfile } : null,
  };
}

function normalizeMashStep(step: RecipeMashStep): RecipeMashStep {
  if (step.amountUnit || !step.amount) return { ...step };
  const match = /^\s*([+-]?[\d.,]+)\s*(L|ml|gal|qt)\s*$/i.exec(step.amount);
  return match
    ? { ...step, amount: match[1]!, amountUnit: match[2]! }
    : { ...step };
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The same, for a field the brewer writes prose into rather than a figure.
 *
 * Blank still becomes null, but what they typed is kept exactly as typed. The
 * trimming {@link nullable} does is fatal to a notes field: it runs on every
 * keystroke, so the space ending "mash " is stripped the instant it is pressed
 * and the next word is typed straight onto the last one — the field simply
 * refuses to take a space. Leading and trailing whitespace is still tidied up,
 * just at the point it matters: `optionalRecipeText` trims on save.
 */
function nullableText(value: string): string | null {
  return value.trim() ? value : null;
}

function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function fermentableAmountKg(amount: string, unit: string): string {
  const parsed = nullableNumber(amount);
  if (parsed == null) return amount;
  const kilograms = unit.trim().toLocaleLowerCase() === 'g'
    ? parsed / 1_000
    : unit.trim().toLocaleLowerCase() === 'lb' || unit.trim().toLocaleLowerCase() === 'lbs'
      ? parsed * 0.45359237
      : unit.trim().toLocaleLowerCase() === 'oz'
        ? parsed * 0.028349523125
        : parsed;
  return String(Math.round(kilograms * 10_000) / 10_000);
}

const WEIGHT_TO_KG: Record<string, number> = { kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, oz: 0.028349523125 };

/**
 * A set of weighed lines summed to kilograms. An unrecognised or blank unit
 * falls back to `fallbackUnit` — the target the caller is about to display in
 * — so a bare number on an otherwise-untouched row reads as "already in that
 * unit" rather than as a stray kilogram.
 */
function sumWeightKg(lines: Array<{ amount: string; unit: string }>, fallbackUnit: 'kg' | 'g' = 'kg'): number {
  const fallback = WEIGHT_TO_KG[fallbackUnit] ?? 1;
  return lines.reduce((sum, line) => {
    const parsed = nullableNumber(line.amount);
    if (parsed == null) return sum;
    const factor = WEIGHT_TO_KG[line.unit.trim().toLocaleLowerCase()] ?? fallback;
    return sum + parsed * factor;
  }, 0);
}

/**
 * A section's grain/hop bill boiled down to one figure for its title — "12.5
 * kg" beside "Fermentables 5" — so the sheet's scale reads without opening
 * every row. Only sections where every line is a weight belong here: mixing a
 * hop's grams with a fining's millilitres would add units that don't add.
 * Null when nothing in the section has a usable amount yet, so an empty or
 * half-filled section's title stays plain.
 */
function totalWeight(lines: Array<{ amount: string; unit: string }>, displayUnit: 'kg' | 'g'): string | null {
  const totalKg = sumWeightKg(lines, displayUnit);
  if (totalKg <= 0) return null;
  const value = displayUnit === 'kg' ? totalKg : totalKg * 1_000;
  return `${Math.round(value * 100) / 100} ${displayUnit}`;
}

/** What the shop's litres weigh, at the 1 g/ml the server prices them by. */
const VOLUME_TO_KG: Record<string, number> = { l: 1, ml: 0.001, liter: 1, litre: 1 };

/**
 * The "other ingredients" section's total for its title. Unlike the grain bill
 * or the hop schedule this list mixes what it's measured in — 3 kg of mango
 * purée, 5 ml of lactic acid, one Whirlfloc tablet — so it totals what can be
 * weighed (litres at the 1 g/ml the costing already assumes) and leaves
 * everything counted rather than weighed out of the figure. Null when nothing
 * in the section has a weight, which is the whole of a section of tablets.
 *
 * Scaled to what it's totalling: a purée-led sour reads better as "4.2 kg" than
 * as 4,200 g, and 15 g of gypsum reads worse as 0.02 kg.
 */
function totalOtherWeight(lines: Array<{ amount: string; unit: string }>): string | null {
  let kilograms = 0;
  for (const line of lines) {
    const parsed = nullableNumber(line.amount);
    if (parsed == null) continue;
    const unit = line.unit.trim().toLocaleLowerCase();
    const factor = WEIGHT_TO_KG[unit] ?? VOLUME_TO_KG[unit];
    if (factor != null) kilograms += parsed * factor;
  }
  if (kilograms <= 0) return null;
  return kilograms >= 1
    ? `${Math.round(kilograms * 100) / 100} kg`
    : `${Math.round(kilograms * 100_000) / 100} g`;
}

/**
 * A section's cost for its title — "254 kr", and a note when the figure is
 * short because the catalogue doesn't stock something. Empty while nothing in
 * the section has been priced, so a section nobody has filled in yet keeps a
 * plain title.
 */
function costParts(cost: CostTotal | null | undefined): string[] {
  if (!cost) return [];
  const parts: string[] = [];
  if (cost.priced > 0) parts.push(kr(cost.usedDkk, 0));
  if (cost.unpriced > 0) parts.push(`${cost.unpriced} unpriced`);
  return parts;
}

/**
 * A section title's trailing summary: how many rows, what they weigh, what they
 * cost. Joined with dashes so the figures read as one line of separate facts
 * rather than as a sum.
 */
function sectionMeta(...parts: Array<string | number | null | undefined>): string | undefined {
  const shown = parts.filter((part) => part != null && part !== '').map(String);
  return shown.length > 0 ? shown.join(' - ') : undefined;
}

/** Strike water per kilo of grain when the recipe hasn't said otherwise. */
export const DEFAULT_MASH_THICKNESS_L_PER_KG = 3;

/**
 * The draft with the first mash step's strike volume filled in from the grain
 * bill — total malt weight × the section's own mash thickness — whenever
 * `autoStrikeVolume` is ticked. Deriving it on render rather than writing it
 * into the draft is what keeps the box a live readout: the "Calculate
 * automatically" checkbox owns the field the same way the boil-volume boxes
 * own theirs, and unticking it is what hands the current number back for the
 * brewer to adjust.
 *
 * Only the first step. A later infusion or sparge addition is a decision about
 * the schedule, not a function of the grain bill.
 */
function withDerivedStrikeVolume(recipe: RecipeEditInput): RecipeEditInput {
  const guidelines = recipe.mashGuidelines;
  const first = guidelines?.steps[0];
  if (!guidelines || !first || !guidelines.autoStrikeVolume) return recipe;
  const thickness = guidelines.startingThicknessLPerKg ?? DEFAULT_MASH_THICKNESS_L_PER_KG;
  const litres = sumWeightKg(recipe.fermentables) * thickness;
  return {
    ...recipe,
    mashGuidelines: {
      ...guidelines,
      steps: guidelines.steps.map((step, index) => index === 0
        ? { ...step, amount: litres > 0 ? String(Math.round(litres * 100) / 100) : '', amountUnit: step.amountUnit || 'L' }
        : step),
    },
  };
}

function options(values: readonly string[]): { value: string }[] {
  return values.map((value) => ({ value }));
}

/** A row nobody has named yet isn't an ingredient, so it isn't costed either. */
function costableDraft(draft: RecipeEditInput): RecipeEditInput {
  const named = <T extends { name: string }>(lines: T[]): T[] =>
    lines.filter((line) => line.name.trim() !== '');
  return {
    ...draft,
    fermentables: named(draft.fermentables),
    hops: named(draft.hops),
    yeast: named(draft.yeast),
    otherIngredients: named(draft.otherIngredients),
  };
}

/**
 * Just the parts of a draft a price depends on. Used to decide when to ask the
 * server again: writing the mash notes or renaming the recipe can't change what
 * it costs, and shouldn't spend a round trip finding that out.
 */
function costSignature(draft: RecipeEditInput): string {
  return JSON.stringify([
    draft.fermentables.map((l) => [l.name, l.amount, l.unit, l.ebc]),
    draft.hops.map((l) => [l.name, l.amount, l.unit]),
    draft.yeast.map((l) => [l.name, l.amount, l.amountUnit]),
    draft.otherIngredients.map((l) => [l.name, l.amount, l.unit]),
    draft.batchSizeL,
  ]);
}

/**
 * What the sheet costs as it stands, re-asked as the ingredients change.
 *
 * The prices live in the server's catalogue (and in the brewer's own overrides),
 * so an unsaved recipe has to ask rather than work it out — hence the debounce:
 * typing "3.5" into an amount shouldn't be four questions. Null until the first
 * answer arrives, and again if one fails: a stale cost quietly attached to a
 * changed grain bill would be worse than no cost at all.
 */
/**
 * The brewery's saved water profiles, for the Target water picker. Read-only
 * here — they're created and edited in the water calculator — and an empty list
 * is a perfectly good answer, so a failed fetch just leaves the built-in style
 * presets standing rather than blocking the editor.
 */
function useSavedWaterProfiles(): SavedWaterProfile[] {
  const [profiles, setProfiles] = useState<SavedWaterProfile[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .listWaterProfiles()
      .then((list) => {
        if (live) setProfiles(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return profiles;
}

function useDraftCost(draft: RecipeEditInput): {
  cost: RecipeCostBreakdown | null;
  /** Ask again without the sheet having changed — after a price was set. */
  refresh: () => void;
} {
  const [cost, setCost] = useState<RecipeCostBreakdown | null>(null);
  // Bumped by `refresh`: a price decision changes what the same draft costs, and
  // the signature below can't see that happen.
  const [asked, setAsked] = useState(0);
  // The signature decides *when* to ask; the ref is what's actually asked, so
  // the request carries the draft as it stands when the debounce finally fires.
  const latest = useRef(draft);
  latest.current = draft;
  const signature = useMemo(() => costSignature(draft), [draft]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .priceRecipe(costableDraft(latest.current))
        .then((next) => {
          if (!cancelled) setCost(next);
        })
        .catch(() => {
          if (!cancelled) setCost(null);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [signature, asked]);
  return { cost, refresh: () => setAsked((count) => count + 1) };
}

export function RecipeEditor({ recipe, saving, error, onSave, onCancel, catalogueOnly = false }: Props): JSX.Element {
  const initial = useMemo(() => editable(recipe), [recipe]);
  const [draft, setDraft] = useState<RecipeEditInput>(initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  // The draft as the brewer sees it: a ticked "calculate automatically" box owns
  // its volume field, so the derived figure — not the stale stored one — is what
  // the field shows and what every statistic below is calculated from. Deriving
  // it on render rather than writing it back keeps the box's own number out of
  // the draft until the box is unticked or the recipe saved.
  const effective = useMemo(() => withAutoBoilVolumes(withDerivedStrikeVolume(draft)), [draft]);
  const calculation = useMemo(() => calculateRecipe(effective), [effective]);
  // What it costs, from the server's catalogue — the one figure on this page
  // that can't be worked out in the browser.
  const { cost, refresh: repriceDraft } = useDraftCost(draft);
  const savedWaterProfiles = useSavedWaterProfiles();
  // The profile this recipe follows, if it still exists. The server resolves the
  // link on read, so a draft opened here already shows the profile's current
  // numbers; this is what tells the UI to say so and to lock the ion fields.
  const linkedWaterProfile =
    savedWaterProfiles.find((p) => p.id === draft.waterProfile?.profileId) ?? null;
  // Which ingredients that total is missing — from the same pricing pass as the
  // figures, so the list names exactly what the cost is short of.
  const unpriced = cost?.unpricedLines ?? [];
  // The panel that prices them holds the list it opened with rather than
  // following this one: pricing an ingredient takes it off `unpriced`, and rows
  // vanishing from under the brewer as they work down them is no way to work
  // down them.
  const [pricingGaps, setPricingGaps] = useState<UnpricedIngredient[] | null>(null);
  // How long the yeast will need, from the strain, the temperature it's held at
  // and the gravity it has to work through — the same estimate the recipe page
  // shows, moving as the sheet is written.
  const fermentation = useMemo(
    () => estimateFermentationDays({
      og: calculation.originalGravity,
      temperatureC: draft.fermentationTemp,
      yeast: draft.yeast,
    }),
    [calculation.originalGravity, draft.fermentationTemp, draft.yeast],
  );
  // Grams of whirlpool and dry hops per litre — the figure the recipe page
  // carries in its hop section, worth watching while the schedule is written.
  const aromaRate = useMemo(
    () => aromaHopRate(draft.hops, draft.batchSizeL),
    [draft.hops, draft.batchSizeL],
  );
  // What each blank tile is still waiting for. Read off the same draft the
  // figures are calculated from, so a tile can never ask for something the
  // arithmetic already has.
  const missing = useCallback(
    (stat: RecipeStatKey) => missingStatInput(effective, stat),
    [effective],
  );
  const styleRange = useMemo(
    () => rangeForStyle(draft.settings.styleSubcategory || draft.style),
    [draft.settings.styleSubcategory, draft.style],
  );
  const prefs = useSettings();
  // What a mash section started from scratch is filled in with — the brewhouse's
  // own figures, not this file's.
  const recipeDefaults = useRecipeDefaults();
  // The same palette the keg board and recipe list wear a beer's colour from,
  // so a style reads as the same swatch everywhere it shows up.
  const kegColors = useKegContentColors();
  const [editingCategories, setEditingCategories] = useState(false);
  const [editingSubstyles, setEditingSubstyles] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<EditorSectionKey, boolean>>(() => loadCollapsed(catalogueOnly));
  // A rail jump asked for but not yet made, and where the last one landed —
  // see goToSection and SectionLanding.
  const [pendingJump, setPendingJump] = useState<{ key: EditorSectionKey } | null>(null);
  const [landed, setLanded] = useState<SectionLanding | null>(null);
  // Which section the rail should light up. Folding one changes where every
  // section under it sits, so the collapse map is what re-measures the page.
  const inView = useSectionInView(collapsed, landed);
  useEffect(() => {
    if (!pendingJump) return;
    // Runs after the commit that unfolded the target, so the page is already as
    // tall as it is going to be and the scroll can land where it was asked to.
    const header = document.getElementById(sectionAnchor(pendingJump.key));
    setPendingJump(null);
    if (!header) return;
    const wanted = header.getBoundingClientRect().top + window.scrollY - SECTION_SCROLL_MARGIN_PX;
    // Clamped here rather than left to the browser, so the landing spot the
    // marker watches for is the one the page will actually come to rest on.
    const y = Math.min(
      Math.max(wanted, 0),
      Math.max(document.documentElement.scrollHeight - window.innerHeight, 0),
    );
    setLanded({ key: pendingJump.key, y });
    window.scrollTo({ top: y, behavior: 'smooth' });
  }, [pendingJump]);
  const [locked, setLocked] = useState<Record<LockedLines, boolean[]>>({ fermentables: [], hops: [], yeast: [] });
  /** Namespace for the amount boxes' ids, so two editors on a page can't collide. */
  const amountIdPrefix = useId();
  const categories = useMemo(() => {
    // The recipe's saved category stays selectable even when the brewer has
    // taken it out of the dropdown — a Brewer's Friend import arrives filed
    // under a BJCP group nobody put there by hand. Keyed off the *saved* value,
    // not the draft: the field reports every keystroke, and half-typed text is
    // not a category.
    const saved = initial.settings.styleCategory;
    return saved && !prefs.recipeStyleCategories.includes(saved)
      ? [...prefs.recipeStyleCategories, saved]
      : prefs.recipeStyleCategories;
  }, [prefs.recipeStyleCategories, initial.settings.styleCategory]);
  // A category we recognise narrows the substyles to its own — to none at all
  // for Brown Ale or Weissbeer, which have none. One we don't (blank, or typed
  // freehand) can't narrow anything, so it offers every substyle in the dropdown.
  const knownCategory = isKnownStyleCategory(draft.settings.styleCategory);
  const hiddenSubstyles = useMemo(
    () => new Set(prefs.recipeHiddenSubstyles),
    [prefs.recipeHiddenSubstyles],
  );
  const styleChoices: StyleChoice[] = useMemo(() => {
    const offered = (known: string): StyleChoice[] => substylesFor(known)
      .filter((value) => !hiddenSubstyles.has(value))
      .map((value) => ({ category: known, value }));
    const category = draft.settings.styleCategory;
    return isKnownStyleCategory(category) ? offered(category) : categories.flatMap(offered);
  }, [categories, draft.settings.styleCategory, hiddenSubstyles]);
  // A family with no substyle of its own becomes the recipe's style; the substyle
  // box stays empty for it rather than echoing the category back at the brewer.
  const substyle = draft.settings.styleSubcategory
    || (draft.style === draft.settings.styleCategory ? '' : draft.style);

  function cancel(): void {
    if (!dirty || window.confirm('Discard your unsaved recipe changes?')) onCancel();
  }

  /** Fold a section away (or back), remembering it for the next recipe. */
  function toggle(key: EditorSectionKey): void {
    setCollapsed((prev) => rememberCollapsed({ ...prev, [key]: !prev[key] }));
  }

  /**
   * Go to a section from the rail. A folded one is unfolded on the way: asking
   * for the water chemistry and landing on a closed lid isn't arriving there.
   *
   * The scroll waits for that unfolding to be drawn rather than happening
   * alongside it. A browser clamps a scroll to the document it currently has,
   * and while the last section is folded the page is too short to bring it to
   * the top — scrolling first would stop short and stay there, since growing
   * the page afterwards doesn't scroll it.
   */
  function goToSection(key: EditorSectionKey): void {
    setCollapsed((prev) => (prev[key] ? rememberCollapsed({ ...prev, [key]: false }) : prev));
    // Boxed so that asking for the same section twice is two requests rather
    // than a no-op React can skip re-rendering for.
    setPendingJump({ key });
  }

  /** The props every section shares: where it is, whether it's open, and how to change that. */
  function section(key: EditorSectionKey): { id: string; open: boolean; onToggle: () => void } {
    return { id: sectionAnchor(key), open: !collapsed[key], onToggle: () => toggle(key) };
  }

  function updateSettings(patch: Partial<RecipeSettings>): void {
    setDraft((current) => ({
      ...current,
      settings: { ...current.settings, ...patch },
    }));
  }

  /** Moving to another category drops the substyle that belonged to the old one. */
  function selectStyleCategory(styleCategory: string): void {
    setDraft((current) => {
      const settings = { ...current.settings, styleCategory };
      const chosen = current.settings.styleSubcategory || current.style;
      // The field reports every keystroke, so half-typed text must leave the
      // style alone: only a category we recognise may clear the substyle.
      if (!isKnownStyleCategory(styleCategory) || substylesFor(styleCategory).includes(chosen)) {
        return { ...current, settings };
      }
      settings.styleSubcategory = '';
      // A family carries the recipe until a substyle is picked; a BJCP group
      // heading ("21. IPA") names no beer, so it leaves the style empty.
      return { ...current, style: categoryIsStyle(styleCategory) ? styleCategory : '', settings };
    });
  }

  function selectStyleSubcategory(styleSubcategory: string): void {
    setDraft((current) => ({
      ...current,
      style: styleSubcategory
        || (categoryIsStyle(current.settings.styleCategory) ? current.settings.styleCategory : ''),
      settings: { ...current.settings, styleSubcategory },
    }));
  }

  return (
    // `items-start` is what lets the rail and the statistics stick: stretched to
    // the sheet's full height they would have nowhere to travel.
    <div className="mt-4 flex items-start gap-4">
      <SectionRail here={inView} onGo={goToSection} />
      {/* Column-reverse below 2xl, so the statistics sit above the sheet on a
          laptop rather than at the foot of it; a row once there is width for a
          column of their own beside it. */}
      <div className="flex min-w-0 flex-1 flex-col-reverse items-start gap-4 2xl:flex-row">
      <form
        className="w-full min-w-0 space-y-4 2xl:flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          // Saved from the effective draft, so the strike volume the brewer has
          // been reading is the one that lands on the sheet.
          void onSave(applyRecipeCalculations(withDerivedStrikeVolume(draft)));
        }}
      >
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <EditorSection title="Recipe setup" icon="📋" description="The same core setup fields used by the Brewer’s Friend editor." {...section('setup')}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Recipe name" value={draft.name} required className="sm:col-span-2 lg:col-span-4" onChange={(name) => setDraft((d) => ({ ...d, name }))} />
            <div className="sm:col-span-2">
              <SearchableSelect
                label="Style category"
                value={draft.settings.styleCategory}
                options={categories.map((value) => ({ value, swatchColor: getRecipeColor({ name: '', style: value }, kegColors) }))}
                onChange={selectStyleCategory}
              />
              <EditListToggle open={editingCategories} onToggle={() => setEditingCategories((open) => !open)} />
            </div>
            <div className="sm:col-span-2">
              <SearchableSelect
                label="Style / subcategory"
                value={substyle}
                options={styleChoices.map((choice) => ({ value: choice.value, description: choice.category, swatchColor: getRecipeColor({ name: '', style: choice.value }, kegColors) }))}
                onChange={selectStyleSubcategory}
                placeholder={knownCategory && styleChoices.length === 0
                  ? `No substyles — saved as ${draft.settings.styleCategory}`
                  : undefined}
                testId="recipe-style-select"
              />
              <EditListToggle open={editingSubstyles} onToggle={() => setEditingSubstyles((open) => !open)} />
            </div>
            {editingCategories && (
              <StyleCategoryEditor
                categories={prefs.recipeStyleCategories}
                onChange={(next) => setSetting('recipeStyleCategories', next)}
                className="sm:col-span-2 lg:col-span-4"
              />
            )}
            {editingSubstyles && (
              <SubstyleEditor
                categories={prefs.recipeStyleCategories}
                hiddenSubstyles={prefs.recipeHiddenSubstyles}
                onChange={(next) => setSetting('recipeHiddenSubstyles', next)}
                className="sm:col-span-2 lg:col-span-4"
              />
            )}

            <Field label="Batch size" value={draft.batchSizeL} suffix="L" type="number" step="any" onChange={(value) => setDraft((d) => ({ ...d, batchSizeL: nullableNumber(value) }))} />
            <SelectField label="Batch target" value={draft.settings.batchTarget} options={options(BATCH_TARGETS)} onChange={(batchTarget) => updateSettings({ batchTarget })} />
            <Field label="Boil time" value={draft.settings.boilTimeMinutes} suffix="min" type="number" step="any" onChange={(value) => updateSettings({ boilTimeMinutes: nullableNumber(value) })} />
            <Field label="Brewhouse efficiency" value={draft.settings.efficiencyPercent} suffix="%" type="number" step="any" onChange={(value) => updateSettings({ efficiencyPercent: nullableNumber(value) })} />

            <div>
              <Field
                label="Pre-boil size"
                value={effective.settings.boilSizePreL}
                suffix="L"
                type="number"
                step="any"
                disabled={draft.settings.autoBoilSizePre}
                placeholder={draft.settings.autoBoilSizePre ? 'Needs a batch size' : undefined}
                onChange={(value) => updateSettings({ boilSizePreL: nullableNumber(value) })}
              />
              <Check
                label="Calculate automatically"
                checked={draft.settings.autoBoilSizePre}
                // Unticking hands back the number the box was showing, so the
                // brewer adjusts the calculated volume instead of an empty field.
                onChange={(autoBoilSizePre) => updateSettings(autoBoilSizePre
                  ? { autoBoilSizePre }
                  : { autoBoilSizePre, boilSizePreL: effective.settings.boilSizePreL })}
              />
            </div>
            <div>
              <Field
                label="Post-boil size"
                value={effective.settings.boilSizePostL}
                suffix="L"
                type="number"
                step="any"
                disabled={draft.settings.autoBoilSizePost}
                placeholder={draft.settings.autoBoilSizePost ? 'Needs a batch size' : undefined}
                onChange={(value) => updateSettings({ boilSizePostL: nullableNumber(value) })}
              />
              <Check
                label="Calculate automatically"
                checked={draft.settings.autoBoilSizePost}
                onChange={(autoBoilSizePost) => updateSettings(autoBoilSizePost
                  ? { autoBoilSizePost }
                  : { autoBoilSizePost, boilSizePostL: effective.settings.boilSizePostL })}
              />
            </div>
          </div>
        </EditorSection>

        <EditorSection title="Fermentables" icon="🌾" meta={sectionMeta(draft.fermentables.length, totalWeight(draft.fermentables, 'kg'), ...costParts(cost?.fermentables))} {...section('fermentables')} onAdd={() => setDraft((d) => ({ ...d, fermentables: [...d.fermentables, blankFermentable()] }))}>
          <div className="space-y-3">
            {draft.fermentables.map((line, index) => (
              <LineCard
                key={index}
                label={`Fermentable ${index + 1}`}
                locked={isLocked('fermentables', index)}
                onToggleLock={() => setLineLock('fermentables', index, !isLocked('fermentables', index))}
                onRemove={() => {
                  setDraft((d) => ({ ...d, fermentables: d.fermentables.filter((_, i) => i !== index) }));
                  dropLineLock('fermentables', index);
                }}
              >
                <div className="grid gap-3 sm:grid-cols-8">
                  {/* Never locked: the catalogue says what a malt *is*, not how
                      much of it this recipe calls for, and picking one is
                      normally the step right before typing the weight. */}
                  <Field id={amountFieldId('fermentables', index)} label="Amount" value={line.amount} suffix="kg" className="sm:col-span-2" onChange={(amount) => updateFermentable(index, { amount, unit: 'kg' })} />
                  <IngredientSearchSelect kind="fermentable" label="Malt / fermentable" value={line.name} className="sm:col-span-4" disabled={isLocked('fermentables', index)} catalogueOnly={catalogueOnly} onChange={(name, option) => {
                    updateFermentable(index, { name, ebc: option?.ebc ?? null, ppg: estimateFermentablePpg(name) });
                    setLineLock('fermentables', index, Boolean(option));
                    // Only for a malt picked off the list. Typing a name by hand
                    // fires this on every keystroke, and jumping the cursor away
                    // mid-word would make the field impossible to type into.
                    if (option) focusAmount('fermentables', index);
                  }} />
                  <ReadOnlyField label="Selected colour" value={line.ebc} decimals={1} suffix="EBC" className="sm:col-span-2" />
                  {/* Filled in from the malt, and editable off a maltster's analysis sheet — this is what the gravities are calculated from. */}
                  <Field label="Extract potential" value={line.ppg} suffix="PPG" type="number" step="any" className="sm:col-span-2" disabled={!line.name.trim() || isLocked('fermentables', index)} placeholder="Pick a malt" onChange={(value) => updateFermentable(index, { ppg: nullableNumber(value) })} />
                  <ReadOnlyField label="Share" value={calculation.fermentablePercents[index]} decimals={1} suffix="%" className="sm:col-span-2" />
                  <div className="flex flex-wrap items-end gap-x-5 sm:col-span-4">
                    <Check
                      label="Late addition"
                      checked={line.lateAddition}
                      disabled={isLocked('fermentables', index)}
                      title="Added after the boil has done its work — kept out of the boil gravity the hops are utilized against, but still counted in the OG."
                      onChange={(lateAddition) => updateFermentable(index, { lateAddition })}
                    />
                    <Check
                      label="Not fermentable"
                      checked={!isFermentableLine(line)}
                      disabled={isLocked('fermentables', index)}
                      title="Lactose, maltodextrin and the like: raises the gravity but never attenuates, so it lands in the FG instead of turning into alcohol."
                      onChange={(notFermentable) => updateFermentable(index, { fermentable: !notFermentable })}
                    />
                  </div>
                </div>
              </LineCard>
            ))}
            <Empty message="No fermentables" show={draft.fermentables.length === 0} />
            <AddRow label="Add a fermentable" onAdd={() => setDraft((d) => ({ ...d, fermentables: [...d.fermentables, blankFermentable()] }))} />
          </div>
        </EditorSection>

        <EditorSection title="Hops" icon="🌿" meta={sectionMeta(draft.hops.length, totalWeight(draft.hops, 'g'), ...costParts(cost?.hops))} {...section('hops')} onAdd={() => setDraft((d) => ({ ...d, hops: [...d.hops, blankHop()] }))}>
          <div className="space-y-3">
            {draft.hops.map((line, index) => (
              <LineCard
                key={index}
                label={`Hop addition ${index + 1}`}
                locked={isLocked('hops', index)}
                onToggleLock={() => setLineLock('hops', index, !isLocked('hops', index))}
                onRemove={() => {
                  setDraft((d) => ({ ...d, hops: d.hops.filter((_, i) => i !== index) }));
                  dropLineLock('hops', index);
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-8">
                  {/* As with the malts: the charge is the recipe's, not the shop's. */}
                  <Field id={amountFieldId('hops', index)} label="Amount" value={line.amount} onChange={(amount) => updateHop(index, { amount })} />
                  <SelectField label="Unit" value={line.unit} options={options(WEIGHT_UNITS)} onChange={(unit) => updateHop(index, { unit })} />
                  <IngredientSearchSelect kind="hop" label="Hop" value={line.name} className="sm:col-span-2 lg:col-span-4" disabled={isLocked('hops', index)} catalogueOnly={catalogueOnly} onChange={(name, option) => {
                    updateHop(index, { name, aa: option?.aa == null ? '' : String(option.aa) });
                    setLineLock('hops', index, option?.aa != null);
                    // Whenever a hop is picked, including one the catalogue has
                    // no alpha acid for — the charge still has to be weighed.
                    if (option) focusAmount('hops', index);
                  }} />
                  <Field label="Alpha acid" value={line.aa} suffix="%" className="lg:col-span-2" disabled={isLocked('hops', index)} onChange={(aa) => updateHop(index, { aa })} />
                  <Field label={hopTimeLabel(line.stage)} value={line.time} className="lg:col-span-2" disabled={isLocked('hops', index)} onChange={(time) => updateHop(index, { time })} />
                  <SelectField label="Time unit" value={line.timeUnit} options={[{ value: '', label: '—' }, { value: 'min', label: 'Minutes' }, { value: 'day', label: 'Days' }]} className="lg:col-span-2" disabled={isLocked('hops', index)} onChange={(timeUnit) => updateHop(index, { timeUnit: timeUnit as RecipeHopEdit['timeUnit'] })} />
                  <SelectField label="Form" value={line.form} options={options(HOP_FORMS)} className="lg:col-span-2" disabled={isLocked('hops', index)} onChange={(form) => updateHop(index, { form })} />
                  <SelectField label="Use" value={line.stage} options={options(HOP_STAGE_ORDER)} className="lg:col-span-2" disabled={isLocked('hops', index)} onChange={(value) => {
                    const stage = value as HopStage;
                    updateHop(index, {
                      stage,
                      use: stage,
                      timeUnit: stage === 'Dry Hop' ? 'day' : 'min',
                      // A stand temperature only means something in a whirlpool;
                      // carried onto a boil addition it would read as a claim
                      // about a kettle that is, by definition, boiling.
                      ...(stage === 'Whirlpool' ? {} : { temp: '' }),
                    });
                  }} />
                  {/* A hopstand is a time *and* a temperature: 20 minutes at 80 °C
                      and the same 20 minutes at flame-out are different beers, and
                      the IBU beside it is calculated from both. */}
                  {line.stage === 'Whirlpool' && (
                    <Field
                      label="Stand temperature"
                      value={line.temp}
                      suffix="°C"
                      className="lg:col-span-2"
                      placeholder="80"
                      disabled={isLocked('hops', index)}
                      onChange={(temp) => updateHop(index, { temp })}
                    />
                  )}
                  <ReadOnlyField label="IBU contribution" value={calculation.hopIbus[index]} decimals={2} className="lg:col-span-2" />
                </div>
                {line.stage === 'Whirlpool' && !line.temp.trim() && (
                  <p className="mt-2 text-[11px] text-zinc-500">
                    Without a stand temperature this addition falls back to a flat 5% utilisation. Fill in the temperature and the time above and its bitterness follows both.
                  </p>
                )}
              </LineCard>
            ))}
            <Empty message="No hop additions" show={draft.hops.length === 0} />
            <AddRow label="Add a hop addition" onAdd={() => setDraft((d) => ({ ...d, hops: [...d.hops, blankHop()] }))} />
          </div>
        </EditorSection>

        <EditorSection title="Yeast" icon="🧫" meta={sectionMeta(draft.yeast.length, ...costParts(cost?.yeast))} {...section('yeast')} onAdd={() => setDraft((d) => ({ ...d, yeast: [...d.yeast, blankYeast()] }))}>
          <div className="space-y-3">
            {draft.yeast.map((line, index) => (
              <LineCard
                key={index}
                label={`Yeast ${index + 1}`}
                locked={isLocked('yeast', index)}
                onToggleLock={() => setLineLock('yeast', index, !isLocked('yeast', index))}
                onRemove={() => {
                  setDraft((d) => ({ ...d, yeast: d.yeast.filter((_, i) => i !== index) }));
                  dropLineLock('yeast', index);
                }}
              >
                {/* Grouped into its own row per purpose rather than one wide
                    grid: six-plus fields sharing a row leave no width for
                    "Attenuation" or "Medium-High" to sit in without spilling
                    into their neighbour, on a laptop or a phone. */}
                <div className="space-y-3">
                  {/* One field for the whole pitch: the catalogue names the
                      producer as part of the strain ("Fermentis SafAle
                      US-05"), and picking one fills the Lab in behind it, so
                      a second box asking for the lab only asked twice. */}
                  <IngredientSearchSelect kind="yeast" label="Yeast / culture" value={line.name} disabled={isLocked('yeast', index)} catalogueOnly={catalogueOnly} onChange={(name, option) => {
                    updateYeast(index, { name, ...yeastFromStrain(option?.yeast) });
                    setLineLock('yeast', index, Boolean(option?.yeast));
                    if (option) focusAmount('yeast', index);
                  }} />
                  <div className="grid gap-3 sm:grid-cols-3">
                    {/* How many sachets to pitch is the brewer's call, not the listing's. */}
                    <Field id={amountFieldId('yeast', index)} label="Amount" value={line.amount} onChange={(amount) => updateYeast(index, { amount })} />
                    <SelectField label="Unit" value={line.amountUnit} options={options([...COUNT_UNITS, ...WEIGHT_UNITS])} onChange={(amountUnit) => updateYeast(index, { amountUnit })} />
                    <Field label="Attenuation" value={line.attenuation} suffix="%" disabled={isLocked('yeast', index)} onChange={(attenuation) => updateYeast(index, { attenuation })} />
                  </div>
                  {/* When it goes in. Never locked — a staged pitch is the
                      recipe's own decision, and no catalogue has an opinion
                      about it. Blank is the ordinary case, so the placeholder
                      says what blank means rather than leaving it to be
                      guessed. */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="Pitched"
                      value={line.addAfterDays}
                      suffix="days in"
                      type="number"
                      step="any"
                      placeholder="At the start"
                      onChange={(addAfterDays) => updateYeast(index, { addAfterDays })}
                    />
                    {/* The vessel's temperature from this pitch onwards, which
                        is how a ramp gets recorded: the kveik going in on day
                        four is also when the fermenter is turned up. */}
                    <Field
                      label="Held at"
                      value={line.heldAtC}
                      suffix="°C"
                      type="number"
                      step="any"
                      placeholder={draft.fermentationTemp ?? "The recipe's temperature"}
                      onChange={(heldAtC) => updateYeast(index, { heldAtC })}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SelectField label="Form" value={line.form} options={options(YEAST_FORMS)} disabled={isLocked('yeast', index)} onChange={(form) => updateYeast(index, { form })} />
                    <SelectField label="Flocculation" value={line.flocculation} options={options(FLOCCULATION_OPTIONS)} disabled={isLocked('yeast', index)} onChange={(flocculation) => updateYeast(index, { flocculation })} />
                  </div>
                  {/* Three across, not four: "Medium-High" is a tolerance as
                      well as a flocculation, and a quarter of this card is
                      too narrow to spell it. */}
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <RangeField
                      label="Optimum temp"
                      min={line.minTempC}
                      max={line.maxTempC}
                      suffix="°C"
                      placeholder="18 – 22"
                      disabled={isLocked('yeast', index)}
                      onChange={(minTempC, maxTempC) => updateYeast(index, { minTempC, maxTempC })}
                    />
                    <Field label="Alcohol tolerance" value={line.alcoholTolerance} disabled={isLocked('yeast', index)} onChange={(alcoholTolerance) => updateYeast(index, { alcoholTolerance })} />
                    <Check label="Starter required" checked={line.starter} className="self-end pb-2" disabled={isLocked('yeast', index)} onChange={(starter) => updateYeast(index, { starter })} />
                  </div>
                  {/* One fermentation temperature per batch, not per pitch —
                      shown once, on the first yeast line, rather than
                      repeated (and editable in six places) across every
                      addition. Still locks with that line: a locked card
                      reads as fully settled, not settled except one field. */}
                  {index === 0 && (
                    <Field label="Fermentation temperature" value={draft.fermentationTemp} suffix="°C" className="sm:max-w-[12rem]" disabled={isLocked('yeast', index)} onChange={(value) => setDraft((d) => ({ ...d, fermentationTemp: nullable(value) }))} />
                  )}
                </div>
              </LineCard>
            ))}
            <Empty message="No yeast" show={draft.yeast.length === 0} />
            <AddRow label="Add a yeast" onAdd={() => setDraft((d) => ({ ...d, yeast: [...d.yeast, blankYeast()] }))} />
            <SearchableSelect label="Pitch rate" value={draft.settings.pitchRate} options={options(PITCH_RATES)} onChange={(pitchRate) => updateSettings({ pitchRate })} className="sm:max-w-xs" />
          </div>
        </EditorSection>

        <EditorSection title="Other ingredients" icon="🧪" meta={sectionMeta(draft.otherIngredients.length, totalOtherWeight(draft.otherIngredients), ...costParts(cost?.other))} metaTitle="Totals what can be weighed — litres at 1 g/ml, the same as the costing. Tablets and other counted additions aren't in the figure." {...section('other')} onAdd={() => setDraft((d) => ({ ...d, otherIngredients: [...d.otherIngredients, blankOther()] }))}>
          <div className="space-y-3">
            {draft.otherIngredients.map((line, index) => (
              <LineCard key={index} label={`Ingredient ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, otherIngredients: d.otherIngredients.filter((_, i) => i !== index) }))}>
                <div className="grid gap-3 sm:grid-cols-6">
                  <Field label="Amount" value={line.amount} onChange={(amount) => updateOther(index, { amount })} />
                  <SelectField label="Unit" value={line.unit} options={options([...WEIGHT_UNITS, ...VOLUME_UNITS, ...COUNT_UNITS])} onChange={(unit) => updateOther(index, { unit })} />
                  <IngredientSearchSelect kind="other" label="Ingredient" value={line.name} className="sm:col-span-4" catalogueOnly={catalogueOnly} onChange={(name) => updateOther(index, { name })} />
                  <Field label="Time" value={line.time} onChange={(time) => updateOther(index, { time })} />
                  <SelectField label="Time unit" value={line.timeUnit} options={[{ value: '', label: '—' }, { value: 'min', label: 'Minutes' }, { value: 'day', label: 'Days' }]} onChange={(timeUnit) => updateOther(index, { timeUnit: timeUnit as RecipeOtherIngredientEdit['timeUnit'] })} />
                  <SelectField label="Type" value={line.type} options={options(OTHER_TYPES)} className="sm:col-span-2" onChange={(type) => updateOther(index, { type })} />
                  <SelectField label="Use" value={line.use} options={options(OTHER_USES)} className="sm:col-span-2" onChange={(use) => updateOther(index, { use })} />
                </div>
              </LineCard>
            ))}
            <Empty message="No other ingredients" show={draft.otherIngredients.length === 0} />
            <AddRow label="Add an ingredient" onAdd={() => setDraft((d) => ({ ...d, otherIngredients: [...d.otherIngredients, blankOther()] }))} />
          </div>
        </EditorSection>

        <EditorSection title="Mash guidelines" icon="🌡️" meta={mashStepMeta(draft.mashGuidelines?.steps.length)} {...section('mash')} onAdd={addMashStep}>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <Field label="Starting mash thickness" value={draft.mashGuidelines?.startingThicknessLPerKg} suffix="L/kg" type="number" step="any" onChange={(value) => updateMashHeader({ startingThicknessLPerKg: nullableNumber(value) })} />
            <Field label="Grain temperature" value={draft.mashGuidelines?.grainTempC} suffix="°C" type="number" step="any" onChange={(value) => updateMashHeader({ grainTempC: nullableNumber(value) })} />
          </div>
          <div className="space-y-3">
            {(draft.mashGuidelines?.steps ?? []).map((line, index) => (
              <LineCard key={index} label={`Mash step ${index + 1}`} onRemove={() => setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, { steps: (d.mashGuidelines?.steps ?? []).filter((_, i) => i !== index) }) }))}>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    {/* Reads from the effective draft so an auto-calculated
                        first step shows the strike volume the grain bill
                        implies. */}
                    <Field
                      label="Amount"
                      value={effective.mashGuidelines?.steps[index]?.amount ?? line.amount ?? ''}
                      disabled={index === 0 && (draft.mashGuidelines?.autoStrikeVolume ?? false)}
                      onChange={(amount) => updateMashStep(index, { amount })}
                    />
                    {index === 0 && (
                      <Check
                        label="Calculate automatically"
                        checked={draft.mashGuidelines?.autoStrikeVolume ?? false}
                        // Unticking hands back the number the box was showing,
                        // so the brewer adjusts the strike volume instead of
                        // an empty field.
                        onChange={(autoStrikeVolume) => updateMashHeader(autoStrikeVolume
                          ? { autoStrikeVolume }
                          : {
                              autoStrikeVolume,
                              steps: (draft.mashGuidelines?.steps ?? []).map((step, i) => i === 0
                                ? { ...step, amount: effective.mashGuidelines?.steps[0]?.amount ?? step.amount }
                                : step),
                            })}
                      />
                    )}
                  </div>
                  <SelectField label="Unit" value={line.amountUnit} options={options(VOLUME_UNITS)} onChange={(amountUnit) => updateMashStep(index, { amountUnit })} />
                  <Field label="Time" value={line.time} suffix="min" onChange={(time) => updateMashStep(index, { time })} />
                  {/* Start, target, type: the row reads in the order the step
                      happens — the water goes in at one temperature, settles
                      at another, and that is what makes it a strike or a
                      decoction. */}
                  <Field label="Start temperature" value={line.startTemp} suffix="°C" onChange={(value) => updateMashStep(index, { startTemp: nullable(value) })} />
                  <Field label="Target temperature" value={line.temp} suffix="°C" onChange={(value) => updateMashStep(index, { temp: nullable(value) })} />
                  <SelectField label="Type" value={line.type || line.name} options={options(MASH_TYPES)} onChange={(type) => updateMashStep(index, { type, name: type })} />
                  <Field label="Description" value={line.description} className="sm:col-span-2 lg:col-span-3" onChange={(description) => updateMashStep(index, { description })} />
                </div>
              </LineCard>
            ))}
            <AddRow label="Add a mash step" onAdd={addMashStep} />
            <label className="block text-xs font-medium text-zinc-400">
              Mash notes
              <textarea className={`${fieldClass} min-h-20 resize-y`} value={draft.mashGuidelines?.notes ?? ''} onChange={(event) => updateMashHeader({ notes: nullableText(event.target.value) })} />
            </label>
          </div>
        </EditorSection>

        <EditorSection title="Water chemistry" icon="💧" meta={draft.waterProfile?.name ?? undefined} description="Source water, target profile, and target ion levels in ppm." {...section('water')}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SearchableSelect label="Source water" value={draft.waterProfile?.sourceName ?? ''} options={options(WATER_SOURCES)} onChange={(value) => updateWater({ sourceName: nullable(value) })} className="sm:col-span-2" />
            {/* Saved profiles lead the list: they're this brewery's own, and a
                name collision with a shipped preset resolves in their favour
                (see chooseWaterTarget). Both kinds sit in one list because to a
                brewer they answer the same question — the description is what
                says which is which, and only one of them stays live. */}
            <SearchableSelect label="Target water" value={draft.waterProfile?.name ?? ''} options={[...savedWaterProfiles.map((profile) => ({ value: profile.name, description: 'Saved profile — stays in step with edits' })), ...TARGET_PRESETS.filter((preset) => !savedWaterProfiles.some((profile) => profile.name === preset.name)).map((preset) => ({ value: preset.name, description: preset.note }))]} onChange={chooseWaterTarget} className="sm:col-span-2" />
            <ReadOnlyField label="Estimated mash pH" value={calculation.mashPh} decimals={2} />
            {/* Locked while linked rather than silently unlinking on the first
                keystroke: a live link is the reason these numbers are what they
                are, and quietly breaking it would leave the recipe looking
                unchanged while it had stopped following anything. Unlink says
                out loud what the brewer is choosing. */}
            {waterFields.map(({ key, label }) => (
              <Field key={key} label={label} value={draft.waterProfile?.[key]} suffix="ppm" disabled={linkedWaterProfile != null} onChange={(value) => updateWater({ [key]: nullable(value) })} />
            ))}
            {linkedWaterProfile && (
              <p className="text-xs leading-snug text-zinc-500 sm:col-span-2 lg:col-span-4">
                Following the saved profile <span className="font-medium text-zinc-300">{linkedWaterProfile.name}</span> — editing it in the water calculator updates this recipe too.
                {linkedWaterProfile.hco3 == null && ' Its bicarbonate is left to the mash-pH model, so the calculator solves it per brew.'}{' '}
                <button type="button" onClick={unlinkWaterProfile} className="font-semibold text-[#f87a68] underline-offset-2 hover:underline">
                  Unlink to edit these numbers
                </button>
              </p>
            )}
            <label className="block text-xs font-medium text-zinc-400 sm:col-span-2 lg:col-span-4">
              Water notes
              <textarea className={`${fieldClass} min-h-20 resize-y`} value={draft.waterProfile?.notes ?? ''} onChange={(event) => updateWater({ notes: nullableText(event.target.value) })} />
            </label>
          </div>
        </EditorSection>

        {/* Everything about the beer that doesn't belong to a step: where the
            idea came from, how the last batch went, what to change next time.
            Last, so it never stands between the brewer and the sheet they came
            here to fill in — and its own section rather than a field tacked
            onto setup, because notes grow. */}
        <EditorSection
          title="Notes"
          icon="📝"
          meta={notesMeta(draft.notes)}
          description="Anything about this recipe as a whole — not the mash or the water, which have notes of their own."
          {...section('notes')}
        >
          <label className="block text-xs font-medium text-zinc-400">
            General notes
            <textarea
              className={`${fieldClass} min-h-32 resize-y`}
              value={draft.notes ?? ''}
              placeholder="Brewed this for Charlotte's birthday. Next time: pitch warmer and dry hop a day earlier."
              onChange={(event) => setDraft((d) => ({ ...d, notes: nullableText(event.target.value) }))}
            />
          </label>
        </EditorSection>

        <div className="sticky bottom-3 z-30 flex items-center justify-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-3 shadow-2xl backdrop-blur">
          <button type="button" onClick={cancel} disabled={saving} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={saving || !dirty} className="rounded-lg bg-gradient-to-br from-[#f87a68] to-[#e0463f] px-4 py-2 text-sm font-semibold text-white shadow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? 'Saving…' : 'Save recipe'}
          </button>
        </div>
      </form>

      {/* The numbers the sheet is being built towards, kept beside it rather
          than in the stack: every one of them moves as an ingredient is typed,
          and watching a gravity answer is half the reason for typing it. Sticky,
          and allowed to scroll inside itself on a short window so the foot of
          the card is never out of reach. */}
      <aside className="w-full 2xl:sticky 2xl:top-5 2xl:max-h-[calc(100vh-2.5rem)] 2xl:w-80 2xl:shrink-0 2xl:overflow-y-auto">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="flex items-center gap-2.5 text-sm font-semibold text-zinc-100">
            <span aria-hidden>📊</span>
            Recipe statistics
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Live from the grain bill, volumes, hops and yeast. Mash pH is an estimate; the cost comes from the shop catalogue.
          </p>
          {/* Two across in the column, a wide row of tiles when the card is
              stacked above the sheet — the same tiles either way, only the grid
              changes. */}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-2">
            <CalculatedStat label="Pre-boil gravity" value={calculation.preBoilGravity} decimals={3} emptyNote={missing('preBoilGravity')} />
            <CalculatedStat label="Post-boil gravity" value={calculation.postBoilGravity} decimals={3} emptyNote={missing('postBoilGravity')} />
            <CalculatedStat label="Original gravity" value={calculation.originalGravity} decimals={3} emptyNote={missing('originalGravity')} />
            <CalculatedStat label="Final gravity" value={calculation.finalGravity} decimals={3} emptyNote={missing('finalGravity')} />
            <CalculatedStat label="ABV" value={calculation.abv} decimals={2} suffix="%" range={styleRange?.abv} compareToStyle emptyNote={missing('abv')} />
            <CalculatedStat label="IBU" value={calculation.ibu} decimals={1} range={styleRange?.ibu} compareToStyle emptyNote={missing('ibu')} />
            {/* The colour that number means, which is what a brewer actually
                pictures when reading an EBC. */}
            <CalculatedStat label="EBC" value={calculation.ebc} decimals={1} range={styleRange?.ebc} compareToStyle swatch={ebcColor(calculation.ebc)} emptyNote={missing('ebc')} />
            <CalculatedStat label="Mash pH estimate" value={calculation.mashPh} decimals={2} emptyNote={missing('mashPh')} />
            {/* How hoppy it will smell, which is what the whirlpool and the dry
                hop are for — the same figure the recipe page carries on its hop
                section, so a schedule can be written to a rate. */}
            <CalculatedStat
              label="Aroma hops"
              value={aromaRate}
              decimals={1}
              suffix="g/L"
              emptyNote={missing('aromaRate')}
              title="Whirlpool and dry hops per litre of batch. The bittering charge is left out — it adds no aroma."
            />
            {/* When the fermenter comes free. An estimate, so it reads as one. */}
            <CalculatedStat
              label="Days to ferment"
              value={fermentation?.days ?? null}
              decimals={0}
              prefix="≈"
              suffix={fermentation && fermentation.days === 1 ? 'day' : 'days'}
              note={fermentation ? `${fermentation.minDays}–${fermentation.maxDays} days` : 'Needs a yeast'}
              title={fermentation?.note ?? 'Pick a yeast to estimate how long fermentation will take.'}
            />
            {/* What the batch costs to fill, beside what it's brewed to. The
                amounts used rather than the packages bought: that's the figure
                that belongs to this recipe, and the one every section title
                adds up to. */}
            <CostStat label="Ingredient cost" cost={cost} onShowUnpriced={unpriced.length > 0 ? () => setPricingGaps(unpriced) : undefined} />
            <CostStat label="Cost per litre" cost={cost} perLitre={draft.batchSizeL} onShowUnpriced={unpriced.length > 0 ? () => setPricingGaps(unpriced) : undefined} />
          </div>
        </div>
      </aside>
      {pricingGaps && (
        <UnpricedIngredientsDialog
          lines={pricingGaps}
          onClose={() => setPricingGaps(null)}
          // A price is stored against the ingredient, so the draft's cost has to
          // be asked for again — nothing on the sheet itself has changed.
          onChanged={repriceDraft}
        />
      )}
      </div>
    </div>
  );

  function updateFermentable(index: number, patch: Partial<RecipeFermentableEdit>): void {
    setDraft((d) => ({ ...d, fermentables: d.fermentables.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }

  /** The amount box belonging to one ingredient line. */
  function amountFieldId(kind: LockedLines, index: number): string {
    return `${amountIdPrefix}-${kind}-amount-${index}`;
  }

  /**
   * Put the cursor in a line's amount box.
   *
   * Choosing an ingredient only ever fills in half a row: the catalogue knows
   * what a malt is, not how much of it this recipe calls for, so the weight is
   * always the next thing typed. Landing there automatically saves a click per
   * ingredient, which over a grain bill and a hop schedule is most of the
   * clicks in writing a recipe.
   *
   * Deferred a frame because the dropdown is still closing when the selection
   * lands — focusing into that teardown just hands the caret straight back. The
   * existing text is selected rather than appended to, so changing the malt on
   * a line that already has a weight lets the new one be typed straight over it.
   */
  function focusAmount(kind: LockedLines, index: number): void {
    requestAnimationFrame(() => {
      const field = document.getElementById(amountFieldId(kind, index));
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
    });
  }

  /**
   * Whether a line's catalogue figures are being protected. Off by default:
   * an empty row, or one whose ingredient was typed rather than picked, has
   * nothing the catalogue vouched for to protect.
   */
  function isLocked(kind: LockedLines, index: number): boolean {
    return locked[kind][index] ?? false;
  }

  /**
   * Lock a line the moment its ingredient is chosen from the catalogue, since
   * that is when the fields fill themselves in. Typing a name by hand instead
   * leaves it open — a custom malt's own numbers are the brewer's to enter.
   */
  function setLineLock(kind: LockedLines, index: number, value: boolean): void {
    setLocked((current) => {
      if ((current[kind][index] ?? false) === value) return current;
      const next = [...current[kind]];
      next[index] = value;
      return { ...current, [kind]: next };
    });
  }

  /** Keep the flags lined up with the rows when one is taken out of the middle. */
  function dropLineLock(kind: LockedLines, index: number): void {
    setLocked((current) => ({ ...current, [kind]: current[kind].filter((_, i) => i !== index) }));
  }
  function updateHop(index: number, patch: Partial<RecipeHopEdit>): void {
    setDraft((d) => ({ ...d, hops: d.hops.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateYeast(index: number, patch: Partial<RecipeYeastEdit>): void {
    setDraft((d) => ({ ...d, yeast: d.yeast.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  function updateOther(index: number, patch: Partial<RecipeOtherIngredientEdit>): void {
    setDraft((d) => ({ ...d, otherIngredients: d.otherIngredients.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  }
  /**
   * A new rest at the foot of the schedule. The first one a sheet gets is a
   * strike at the brewhouse's own temperatures with its volume calculated from
   * the grain bill — the mash every batch here starts from; a later step is a
   * decision with no default worth guessing, so it starts blank.
   */
  function addMashStep(): void {
    setDraft((d) => {
      const steps = d.mashGuidelines?.steps ?? [];
      const isFirst = steps.length === 0;
      return {
        ...d,
        mashGuidelines: {
          startingThicknessLPerKg: d.mashGuidelines?.startingThicknessLPerKg ?? recipeDefaults.mashThicknessLPerKg,
          grainTempC: d.mashGuidelines?.grainTempC ?? null,
          autoStrikeVolume: isFirst ? true : d.mashGuidelines?.autoStrikeVolume ?? false,
          steps: [...steps, isFirst ? defaultFirstMashStep(recipeDefaults) : blankMashStep()],
          notes: d.mashGuidelines?.notes ?? null,
        },
      };
    });
  }
  function updateMashStep(index: number, patch: Partial<RecipeMashStep>): void {
    setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, { steps: (d.mashGuidelines?.steps ?? []).map((line, i) => i === index ? { ...line, ...patch } : line) }) }));
  }
  function updateMashHeader(patch: Partial<NonNullable<RecipeEditInput['mashGuidelines']>>): void {
    setDraft((d) => ({ ...d, mashGuidelines: mashWith(d, patch) }));
  }
  function updateWater(patch: Partial<RecipeWaterProfile>): void {
    setDraft((d) => ({ ...d, waterProfile: { ...blankWater(), ...(d.waterProfile ?? {}), ...patch } }));
  }
  /**
   * Saved profiles are matched before the built-in presets, so a brewery that
   * saves its own "Balanced" gets its own — the point of saving one is that it
   * beats the shipped table. Picking a saved profile links the recipe to it by
   * id; picking a preset, or typing a name of your own, leaves the recipe
   * standing on its own numbers.
   *
   * The ppm figures are copied either way. For a linked recipe they're only a
   * snapshot — the server overwrites them from the profile on every read — but
   * writing them now means the fields are right before the next fetch, and it's
   * what the recipe falls back to if the profile is ever deleted.
   */
  function chooseWaterTarget(name: string): void {
    const saved = savedWaterProfiles.find((candidate) => candidate.name === name);
    if (saved) {
      updateWater({ name: saved.name, profileId: saved.id, ...savedWaterFields(saved) });
      return;
    }
    const preset = TARGET_PRESETS.find((candidate) => candidate.name === name);
    updateWater({
      name: nullable(name),
      profileId: null,
      ...(preset ? {
        calcium: String(preset.profile.ca),
        magnesium: String(preset.profile.mg),
        sodium: String(preset.profile.na),
        chloride: String(preset.profile.cl),
        sulfate: String(preset.profile.so4),
        bicarbonate: String(preset.profile.hco3),
      } : {}),
    });
  }

  /**
   * Stop following the saved profile, keeping the numbers it was showing. The
   * brewer wants this recipe to differ from the profile — the alternative would
   * be editing the profile, which changes every other recipe using it.
   */
  function unlinkWaterProfile(): void {
    updateWater({ profileId: null });
  }
}

function mashWith(draft: RecipeEditInput, patch: Partial<NonNullable<RecipeEditInput['mashGuidelines']>>): NonNullable<RecipeEditInput['mashGuidelines']> {
  return {
    startingThicknessLPerKg: draft.mashGuidelines?.startingThicknessLPerKg ?? null,
    grainTempC: draft.mashGuidelines?.grainTempC ?? null,
    autoStrikeVolume: draft.mashGuidelines?.autoStrikeVolume ?? false,
    steps: draft.mashGuidelines?.steps ?? [],
    notes: draft.mashGuidelines?.notes ?? null,
    ...patch,
  };
}

/**
 * The contents rail down the left of the sheet: one line per section, lit on
 * whichever the page is scrolled to. A brew sheet is eight panels tall by the
 * time it has a grain bill in it, and reaching the water chemistry from the
 * fermentables shouldn't be a scroll.
 *
 * Hidden below `lg`, where the page has no width to give it and the sheet
 * itself is what the screen is for — the same call the library reader's
 * contents make on a phone.
 */
function SectionRail({ here, onGo }: { here: EditorSectionKey | null; onGo: (key: EditorSectionKey) => void }): JSX.Element {
  return (
    <nav aria-label="Recipe sections" className="sticky top-5 hidden w-44 shrink-0 lg:block">
      <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
        Sections
      </div>
      {SECTION_RAIL.map(({ key, icon, label }) => {
        const active = key === here;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onGo(key)}
            title={label}
            aria-current={active ? 'location' : undefined}
            className={`mb-0.5 flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-2 text-left text-xs leading-snug transition ${
              active
                ? 'border-[#f87a68] font-medium text-zinc-200'
                : 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
            }`}
          >
            <span aria-hidden className="shrink-0 text-[13px]">{icon}</span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** "3 steps" for a mash section's title, or nothing while it has none. */
function mashStepMeta(steps: number | undefined): string | undefined {
  return steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined;
}

/**
 * One panel of the brew sheet being written — the same collapsible card the
 * recipe page reads a saved sheet from, so a section is recognisably the same
 * thing in both places, with the editor's "+ Add" in its header.
 */
function EditorSection({ id, title, icon, meta, metaTitle, description, open, onToggle, onAdd, children }: { id: string; title: string; icon: string; meta?: string; metaTitle?: string; description?: string; open: boolean; onToggle: () => void; onAdd?: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <SheetSection
      id={id}
      title={title}
      icon={icon}
      meta={meta}
      metaTitle={metaTitle}
      description={description}
      open={open}
      onToggle={onToggle}
      action={
        // Adding a row to a folded section would drop it out of sight, so it
        // unfolds first — the brewer asked to fill something in.
        onAdd && (
          <button type="button" onClick={() => { if (!open) onToggle(); onAdd(); }} className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800">+ Add</button>
        )
      }
    >
      <div className="p-4">{children}</div>
    </SheetSection>
  );
}

/** Opens the panel that edits what a style dropdown offers. */
function EditListToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 text-[11px] font-medium text-zinc-500 underline-offset-2 transition hover:text-zinc-200 hover:underline"
    >
      {open ? 'Done editing list' : 'Edit list…'}
    </button>
  );
}

/** Header shared by both dropdown editors: what the list is, and a way back to the default. */
function StyleListHeader({ title, hint, isDefault, onReset }: { title: string; hint: string; isDefault: boolean; onReset: () => void }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-xs font-semibold text-zinc-300">{title}</div>
        <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>
      </div>
      {!isDefault && (
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:bg-zinc-800"
        >
          Reset
        </button>
      )}
    </div>
  );
}

/** One removable entry in the dropdown editors below. */
function StyleChip({ label, onRemove }: { label: string; onRemove: () => void }): JSX.Element {
  return (
    <span className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 py-1 pl-3 pr-1 text-xs text-zinc-200">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300"
      >
        ×
      </button>
    </span>
  );
}

/**
 * Add/remove panel for the "Style category" dropdown. Every category the app
 * knows is on offer — the brewery's own families plus the full BJCP taxonomy —
 * so the dropdown holds the beers this brewer actually makes.
 *
 * The list is a browser preference, not part of the recipe, so edits here save
 * immediately and apply to every recipe rather than to the one being edited.
 */
function StyleCategoryEditor({ categories, onChange, className = '' }: { categories: string[]; onChange: (categories: string[]) => void; className?: string }): JSX.Element {
  const listed = new Set(categories);
  const missing = ALL_STYLE_CATEGORIES.filter((category) => !listed.has(category));
  const isDefault = categories.length === DEFAULT_STYLE_CATEGORIES.length
    && categories.every((category, index) => category === DEFAULT_STYLE_CATEGORIES[index]);
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 ${className}`}>
      <StyleListHeader
        title="Style category dropdown"
        hint="Saved in this browser and used by every recipe. Removing a category never changes recipes already saved under it — the dropdown still offers a recipe its own category."
        isDefault={isDefault}
        onReset={() => onChange([...DEFAULT_STYLE_CATEGORIES])}
      />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {categories.map((category) => (
          <StyleChip
            key={category}
            label={category}
            onRemove={() => onChange(categories.filter((other) => other !== category))}
          />
        ))}
        {categories.length === 0 && (
          <span className="text-[11px] text-zinc-600">Empty — the dropdown offers nothing until you add a category.</span>
        )}
      </div>
      <SearchableSelect
        label="Add a category"
        value=""
        options={missing.map((value) => ({
          value,
          description: categoryIsStyle(value) ? 'Brewery style' : 'BJCP group',
        }))}
        // Only an actual pick counts: the field reports every keystroke, and a
        // half-typed word is not a category worth adding to anyone's dropdown.
        onChange={(_value, option) => option && onChange([...categories, option.value])}
        placeholder={missing.length === 0 ? 'Every category is already listed' : 'Search the full BJCP list…'}
        allowCustom={false}
        className="mt-2.5"
      />
    </div>
  );
}

/**
 * Add/remove panel for the "Style / subcategory" dropdown, grouped by the
 * category each substyle hangs off — the second dropdown only ever shows one
 * category's worth, so the grouping is what makes the list legible.
 *
 * Stored as removals rather than a kept list: adding a category should bring
 * its substyles with it, not leave this dropdown empty until they're re-added
 * one by one.
 */
function SubstyleEditor({ categories, hiddenSubstyles, onChange, className = '' }: { categories: string[]; hiddenSubstyles: string[]; onChange: (substyles: string[]) => void; className?: string }): JSX.Element {
  const listed = new Set(categories);
  const hidden = new Set(hiddenSubstyles);
  const belongsToListed = (owners: string[]): boolean => owners.some((owner) => listed.has(owner));
  // A substyle is in the dropdown when one of the categories it belongs to is
  // listed and the brewer hasn't taken it out; everything else can be added.
  const addable = ALL_SUBSTYLES
    .filter(({ value, categories: owners }) => hidden.has(value) || !belongsToListed(owners))
    .map(({ value, categories: owners }) => ({
      value,
      description: owners.join(' · '),
      // Greyed rather than dropped: a substyle whose category isn't in the other
      // dropdown should show *why* it can't be added, not vanish from the list.
      disabled: !belongsToListed(owners),
    }));
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 ${className}`}>
      <StyleListHeader
        title="Substyle dropdown"
        hint="Grouped by the style category each one belongs to. A substyle can only be added once its category is in the category dropdown; the rest stay greyed out."
        isDefault={hiddenSubstyles.length === 0}
        onReset={() => onChange([])}
      />
      <div className="mt-2.5 space-y-2">
        {categories.map((category) => {
          const all = substylesFor(category);
          const shown = all.filter((value) => !hidden.has(value));
          return (
            <div key={category}>
              <div className="text-[11px] text-zinc-500">{category}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {shown.map((value) => (
                  <StyleChip
                    key={value}
                    label={value}
                    onRemove={() => onChange([...hiddenSubstyles, value])}
                  />
                ))}
                {shown.length === 0 && (
                  <span className="text-[11px] text-zinc-600">
                    {all.length === 0
                      ? `No substyles — a recipe is saved as ${category} itself.`
                      : 'All removed — add one back below.'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {categories.length === 0 && (
          <span className="text-[11px] text-zinc-600">No style categories listed, so there are no substyles to offer.</span>
        )}
      </div>
      <SearchableSelect
        label="Add a substyle"
        value=""
        options={addable}
        onChange={(_value, option) => option && onChange(hiddenSubstyles.filter((other) => other !== option.value))}
        placeholder={addable.length === 0 ? 'Every substyle is already listed' : 'Search every substyle…'}
        allowCustom={false}
        className="mt-2.5"
      />
    </div>
  );
}

function LineCard({ label, onRemove, locked, onToggleLock, children }: { label: string; onRemove: () => void; locked?: boolean; onToggleLock?: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
        <div className="flex items-center gap-1">
          {onToggleLock && (
            <button
              type="button"
              onClick={onToggleLock}
              aria-pressed={locked ?? false}
              aria-label={`${locked ? 'Unlock' : 'Lock'} the catalogue figures on ${label}`}
              title={locked
                ? 'These figures came from the catalogue. Unlock to type your own.'
                : 'Lock the catalogue figures so they cannot be changed by accident.'}
              className={`rounded px-2 py-1 text-xs transition ${
                locked ? 'text-zinc-300 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              {locked ? '🔒 Locked' : '🔓 Unlocked'}
            </button>
          )}
          <button type="button" onClick={onRemove} className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300" aria-label={`Remove ${label}`}>Remove</button>
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Room to keep the suffix off the value, scaled to the suffix itself. A flat
 * reservation wide enough for "L/kg" leaves a "°C" field in a six-across row
 * with barely a character of usable width, which is how "71" comes out reading
 * as "7".
 */
/**
 * What a collapsed Notes header says: how much is written, so a folded section
 * doesn't hide the fact that there is something in it. Undefined when empty —
 * "0 words" is a worse answer than saying nothing.
 */
function notesMeta(notes: string | null): string | undefined {
  const words = (notes ?? '').trim().split(/\s+/).filter(Boolean).length;
  return words === 0 ? undefined : `${words} word${words === 1 ? '' : 's'}`;
}

function suffixPadding(suffix: string | undefined): string {
  if (!suffix) return '';
  if (suffix.length <= 2) return 'pr-8';
  return suffix.length === 3 ? 'pr-10' : 'pr-12';
}

function Field({ label, value, onChange, suffix, className = '', required = false, type = 'text', step, placeholder, disabled = false, id }: { label: string; value: string | number | null | undefined; onChange: (value: string) => void; suffix?: string; className?: string; required?: boolean; type?: string; step?: string; placeholder?: string; disabled?: boolean; /** Only needed by a field something else has to move the cursor into. */ id?: string }): JSX.Element {
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <div className="relative">
        {/* Tidied when the field is left rather than as it is typed: ".8" is a
            complete number one keystroke before ".85" is, and re-writing the box
            mid-word would move the caret out from under whoever is still
            typing. Same rule the range field follows. */}
        <input id={id} className={`${fieldClass} ${suffixPadding(suffix)} disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-400`} value={value ?? ''} onChange={(event) => onChange(event.target.value)} onBlur={(event) => { const tidied = withLeadingZero(event.target.value); if (tidied !== event.target.value) onChange(tidied); }} required={required} type={type} step={step} placeholder={placeholder} disabled={disabled} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 top-1 flex items-center text-xs text-zinc-600">{suffix}</span>}
      </div>
    </label>
  );
}

/**
 * A low–high pair as the one thing it describes: a yeast's optimum temperature
 * is a range, and two boxes asking for its ends separately read as two settings
 * to decide rather than one figure to copy off the sachet.
 *
 * What is typed is kept as typed until the field is left, so a range can be
 * written left to right — "18 –" parses to no maximum, and re-formatting it
 * mid-keystroke would take the dash back out again.
 */
function RangeField({ label, min, max, onChange, suffix, placeholder, className = '', disabled = false }: { label: string; min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void; suffix?: string; placeholder?: string; className?: string; disabled?: boolean }): JSX.Element {
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <div className="relative">
        <input
          className={`${fieldClass} ${suffixPadding(suffix)} disabled:cursor-not-allowed disabled:bg-zinc-900 disabled:text-zinc-400`}
          value={typed ?? formatRange(min, max)}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            setTyped(event.target.value);
            const [low, high] = parseRange(event.target.value);
            onChange(low, high);
          }}
          onBlur={() => setTyped(null)}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 top-1 flex items-center text-xs text-zinc-600">{suffix}</span>}
      </div>
    </label>
  );
}

function formatRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return '';
  if (min == null) return `– ${max}`;
  if (max == null || max === min) return String(min);
  return `${min} – ${max}`;
}

/** "18 – 22", "18-22", "18 to 22" and "18 22" all read as the same range. */
function parseRange(value: string): [number | null, number | null] {
  const ends = /^\s*(-?[\d.,]+)?\s*(?:to|[–—-])?\s*(-?[\d.,]+)?\s*$/i.exec(value);
  if (!ends) return [null, null];
  return [nullableNumber(ends[1] ?? ''), nullableNumber(ends[2] ?? '')];
}

/** The producer's figures for a picked strain, as a patch for the pitch line. */
function yeastFromStrain(spec: RecipeYeastSpec | null | undefined): Partial<RecipeYeastEdit> {
  if (!spec) return {};
  return {
    ...(spec.lab ? { lab: spec.lab } : {}),
    ...(spec.type ? { type: spec.type } : {}),
    ...(spec.form ? { form: spec.form } : {}),
    ...(spec.attenuation ? { attenuation: spec.attenuation } : {}),
    ...(spec.flocculation ? { flocculation: spec.flocculation } : {}),
    ...(spec.alcoholTolerance ? { alcoholTolerance: spec.alcoholTolerance } : {}),
    ...(spec.minTempC != null || spec.maxTempC != null
      ? { minTempC: spec.minTempC, maxTempC: spec.maxTempC }
      : {}),
  };
}

function ReadOnlyField({ label, value, decimals, suffix, className = '' }: { label: string; value: number | null | undefined; decimals: number; suffix?: string; className?: string }): JSX.Element {
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      {/* Same grey a locked or disabled field wears — this one is never
          editable at all, so it should never read as brighter than one that
          merely can't be touched right now. `!` forces the override: this is a
          plain div with no `:disabled` state to out-specificity fieldClass's
          own bg-zinc-950, unlike the real inputs. */}
      <div className={`${fieldClass} flex min-h-[38px] cursor-not-allowed items-center justify-between !bg-zinc-900 text-zinc-400`}>
        <span>{value == null ? '—' : value.toFixed(decimals)}</span>
        {suffix && <span className="text-xs text-zinc-600">{suffix}</span>}
      </div>
    </label>
  );
}

function CalculatedStat({ label, value, decimals, prefix = '', suffix = '', range, compareToStyle = false, swatch, note, emptyNote, title }: { label: string; value: number | null; decimals: number; /** Sits in front of the figure — "≈" for a figure that is openly approximate. */ prefix?: string; suffix?: string; range?: [number, number]; compareToStyle?: boolean; /** Colour the figure stands for, shown as a dot beside it. */ swatch?: string | null; /** Replaces the style-range line, for a figure no style has a range for. */ note?: string; /** What this particular figure is still waiting for, in place of the generic "needs more inputs". */ emptyNote?: string | null; /** Tooltip, for a figure that needs its caveats spelled out. */ title?: string }): JSX.Element {
  const status = note != null
    ? { text: note, className: 'text-zinc-500' }
    : value == null
      ? { text: emptyNote ?? 'Needs more inputs', className: 'text-zinc-500' }
      : !range
        ? { text: 'No BJCP range', className: 'text-zinc-500' }
        : value < range[0]
          ? { text: `Below ${range[0]}–${range[1]}`, className: 'text-amber-300' }
          : value > range[1]
            ? { text: `Above ${range[0]}–${range[1]}`, className: 'text-amber-300' }
            : { text: `In range ${range[0]}–${range[1]}`, className: 'text-emerald-300' };
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5" title={title}>
      <div className="text-[11px] font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xl font-semibold tabular-nums text-zinc-100">
        <span>
          {value == null ? '—' : `${prefix}${value.toFixed(decimals)}`}
          {value != null && suffix && <span className="ml-1 text-xs font-normal text-zinc-500">{suffix}</span>}
        </span>
        {swatch && (
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-full"
            style={{ backgroundColor: swatch }}
            title={`${value?.toFixed(decimals)} EBC`}
            aria-hidden
          />
        )}
      </div>
      {(compareToStyle || note != null || value == null) && <div className={`mt-1 text-[10px] ${status.className}`}>{status.text}</div>}
    </div>
  );
}

/**
 * What the sheet costs, in the same row as what it's brewed to. Two figures out
 * of one breakdown: the batch total, and — with a batch size to divide by — what
 * that is per litre.
 *
 * The amounts used, not the packages to buy: buying a 100 g bag for a 30 g
 * addition is a shopping decision, and pinning it to the recipe would make the
 * cost jump every time an addition crossed a bag boundary. Coverage is stated
 * rather than assumed: a total over a grain bill the shop doesn't stock has to
 * say how much of itself is missing.
 */
function CostStat({ label, cost, perLitre, onShowUnpriced }: { label: string; cost: RecipeCostBreakdown | null; perLitre?: number | null; /** Opens the panel that prices what the total is missing; absent when nothing is. */ onShowUnpriced?: () => void }): JSX.Element {
  const total = cost?.cost;
  const value = total == null || total.priced === 0 || (perLitre != null && perLitre <= 0)
    ? null
    : perLitre == null
      ? kr(total.usedDkk, 0)
      : kr(total.usedDkk / perLitre, 2);
  // What's short about the figure, and whether it's the kind of shortfall the
  // brewer can do something about from here — a missing price is, a missing
  // batch size isn't, and only the ones that are become a control.
  const note: { text: string; fixable?: boolean } | null = cost == null
    ? { text: 'Waiting for prices' }
    : !cost.pricing.available
      ? { text: 'No price catalogue' }
      : total && total.priced === 0
        ? { text: 'Nothing priced yet', fixable: total.unpriced > 0 }
        : perLitre != null && !(perLitre > 0)
          ? { text: 'Needs a batch size' }
          : total && total.unpriced > 0
            ? { text: `${total.unpriced} unpriced`, fixable: true }
            : null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
      <div className="text-[11px] font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-zinc-100">{value ?? '—'}</div>
      {note && (
        note.fixable && onShowUnpriced ? (
          <button
            type="button"
            onClick={onShowUnpriced}
            title="Show these ingredients and set their prices"
            className="mt-1 block text-[10px] text-amber-300 underline decoration-amber-300/40 underline-offset-2 transition hover:decoration-amber-300"
          >
            {note.text}
          </button>
        ) : (
          <div className={`mt-1 text-[10px] ${value != null ? 'text-amber-300' : 'text-zinc-500'}`}>{note.text}</div>
        )
      )}
    </div>
  );
}

/**
 * The second "+ Add" for a section, under its last row. The header's one is
 * where a section is started from; this one is where a list is *continued*, and
 * after typing a fifth malt the top of the section is a scroll away.
 */
function AddRow({ label, onAdd }: { label: string; onAdd: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="w-full rounded-lg border border-dashed border-zinc-700 px-4 py-2 text-xs font-semibold text-zinc-400 transition hover:border-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
    >
      + {label}
    </button>
  );
}

/** What a hop addition's time box is asking for, which the stage decides. */
function hopTimeLabel(stage: HopStage): string {
  if (stage === 'Dry Hop') return 'Contact time';
  if (stage === 'Whirlpool') return 'Stand time';
  return 'Time';
}

function SelectField({ label, value, options: choices, onChange, className = '', disabled = false }: { label: string; value: string; options: Array<{ value: string; label?: string }>; onChange: (value: string) => void; className?: string; disabled?: boolean }): JSX.Element {
  const all = choices.some((choice) => choice.value === value) || value === ''
    ? choices
    : [{ value }, ...choices];
  return (
    <label className={`block text-xs font-medium text-zinc-400 ${className}`}>
      {label}
      <Select
        className={`${fieldClass} disabled:bg-zinc-900 disabled:text-zinc-400`}
        value={value}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        options={all}
      />
    </label>
  );
}

function Check({ label, checked, onChange, className = '', title, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; className?: string; title?: string; disabled?: boolean }): JSX.Element {
  return (
    <label title={title} className={`mt-2 flex items-center gap-2 text-xs font-medium ${disabled ? 'text-zinc-600' : 'text-zinc-400'} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-zinc-600 bg-zinc-950 accent-[#e95449] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {label}
    </label>
  );
}

function Empty({ message, show }: { message: string; show: boolean }): JSX.Element | null {
  return show ? <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-5 text-center text-sm text-zinc-600">{message}. Use Add to create a row.</div> : null;
}

function blankFermentable(): RecipeFermentableEdit {
  return { name: '', amount: '', unit: 'kg', percent: '', ebc: null, ppg: null, fermentable: null, lateAddition: false };
}
function blankHop(): RecipeHopEdit {
  return { name: '', amount: '', unit: 'g', use: 'Boil', stage: 'Boil', time: '', timeUnit: 'min', aa: '', ibu: '', form: 'Pellet', utilization: '', temp: '' };
}
function blankYeast(): RecipeYeastEdit {
  return { name: '', lab: '', attenuation: '', amount: '1', amountUnit: 'each', type: 'Ale', form: 'Dry', flocculation: '', minTempC: null, maxTempC: null, alcoholTolerance: '', starter: false, addAfterDays: '', heldAtC: '' };
}
function blankOther(): RecipeOtherIngredientEdit {
  return { name: '', amount: '', unit: 'g', use: 'Boil', time: '', timeUnit: 'min', type: 'Flavor' };
}
function blankMashStep(): RecipeMashStep {
  return { name: 'Strike', type: 'Strike', temp: null, startTemp: null, time: '', amount: '', amountUnit: 'L', description: '' };
}

/**
 * The mash guideline section's first row, filled in rather than left blank: a
 * single-infusion strike at the temperatures the Recipes settings name. The
 * amount starts empty — the caller is expected to also turn on
 * `autoStrikeVolume`, which is what makes {@link withDerivedStrikeVolume} fill
 * it from the grain bill. Only the first row gets this treatment; a later
 * mash-out or sparge has no one-size guess worth making, so it still starts
 * from `blankMashStep`.
 */
export function defaultFirstMashStep(defaults: RecipeDefaults): RecipeMashStep {
  return {
    name: 'Strike',
    type: 'Strike',
    startTemp: String(defaults.mashStrikeTempC),
    temp: String(defaults.mashTargetTempC),
    time: String(defaults.mashStepMinutes),
    amount: '',
    amountUnit: 'L',
    description: '',
  };
}
function blankWater(): RecipeWaterProfile {
  return { sourceName: null, profileId: null, name: null, ph: null, notes: null, calcium: null, magnesium: null, sodium: null, chloride: null, sulfate: null, bicarbonate: null };
}

/** A saved profile's ppm figures as the recipe stores them — strings, or null. */
function savedWaterFields(profile: SavedWaterProfile): Partial<RecipeWaterProfile> {
  return {
    calcium: String(profile.ca),
    magnesium: String(profile.mg),
    sodium: String(profile.na),
    chloride: String(profile.cl),
    sulfate: String(profile.so4),
    // Left blank rather than zeroed: this profile defers to the grist, and the
    // water calculator solves the figure per brew.
    bicarbonate: profile.hco3 == null ? null : String(profile.hco3),
  };
}

const waterFields: { key: 'calcium' | 'magnesium' | 'sodium' | 'chloride' | 'sulfate' | 'bicarbonate'; label: string }[] = [
  { key: 'calcium', label: 'Calcium' },
  { key: 'magnesium', label: 'Magnesium' },
  { key: 'sodium', label: 'Sodium' },
  { key: 'chloride', label: 'Chloride' },
  { key: 'sulfate', label: 'Sulfate' },
  { key: 'bicarbonate', label: 'Bicarbonate' },
];
