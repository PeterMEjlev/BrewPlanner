import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core';

/**
 * Touch building blocks shared by the kiosk views (checklist display + to-do).
 * Keeping them here avoids duplicating the long-press drag config and the
 * info/description chrome between pages.
 */

/** Long-press to start a drag, so a quick tap still toggles and a swipe scrolls. */
export function useTouchSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );
}

/**
 * Round "i" badge overlaid on a step/to-do tile. It sits above the toggle
 * button (a sibling, not a child) so a tap opens the description instead of
 * ticking the item off.
 */
export function InfoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-4 top-1/2 flex h-14 w-14 -tranzinc-y-1/2 items-center justify-center rounded-full bg-zinc-700/90 text-3xl font-bold italic text-zinc-100 shadow-lg active:bg-zinc-600"
      aria-label="Show description"
    >
      i
    </button>
  );
}

/** Modal showing an item's title and its full description. */
export function DescriptionModal({
  title,
  description,
  onClose,
}: {
  title: string;
  description: string;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-zinc-800 p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-2xl font-bold text-white">{title}</p>
        <p className="mt-4 overflow-y-auto whitespace-pre-wrap text-xl leading-relaxed text-zinc-200">
          {description}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-8 w-full shrink-0 rounded-xl bg-zinc-600 py-4 text-2xl font-semibold text-white active:bg-zinc-500"
        >
          Close
        </button>
      </div>
    </div>
  );
}
