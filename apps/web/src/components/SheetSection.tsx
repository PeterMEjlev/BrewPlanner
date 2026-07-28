/**
 * One collapsible card of a brew sheet, shared by the recipe page and the recipe
 * editor: a section reads the same whether it is being read or filled in — icon,
 * title, a one-line summary of what's inside, and a chevron — so the two pages
 * are recognisably the same sheet rather than two takes on it.
 */
export function SheetSection({
  id,
  title,
  icon,
  meta,
  metaTitle,
  description,
  action,
  open,
  onToggle,
  children,
}: {
  /** Anchor for a contents rail to scroll to and measure against. */
  id?: string;
  title: string;
  icon: string;
  /** Summary shown next to the title (a total, a count, a cost, a profile name). */
  meta?: string;
  /** Tooltip explaining `meta` when the number needs a caveat. */
  metaTitle?: string;
  /** A line under the title, for a section whose purpose isn't self-evident. */
  description?: string;
  /** Header control that isn't the toggle — the editor's "+ Add" button. */
  action?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): JSX.Element {
  // Deliberately not `overflow-hidden`: an ingredient row's price picker is
  // positioned against its own row and would be clipped at the section's edge.
  // The header rounds its own corners instead, which is all the clipping did.
  return (
    <section id={id} className="rounded-xl border border-zinc-800 bg-zinc-900">
      <div className={`flex items-center ${action ? 'gap-2 pr-3' : ''}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={`flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3 text-left transition hover:bg-zinc-800/50 ${
            open ? 'rounded-t-xl' : 'rounded-xl'
          }`}
        >
          <span aria-hidden>{icon}</span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-baseline gap-x-2.5">
              <span className="text-sm font-semibold text-zinc-100">{title}</span>
              {meta && (
                <span className="truncate text-xs text-zinc-500" title={metaTitle}>
                  {meta}
                </span>
              )}
            </span>
            {description && <span className="mt-0.5 block text-xs text-zinc-500">{description}</span>}
          </span>
          <span
            className={`ml-auto shrink-0 pl-2 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`}
            aria-hidden
          >
            ⌄
          </span>
        </button>
        {action}
      </div>
      {open && <div className="border-t border-zinc-800">{children}</div>}
    </section>
  );
}
