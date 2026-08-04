/**
 * Ordering rules for the nav rail the brewer rearranges by long-pressing a
 * sidebar entry (see DashboardShell). The arrangement is stored in per-browser
 * settings as a list of nav keys; these turn that list into an order and back.
 *
 * They live here, apart from the shell, because both are quietly full of edge
 * cases — a saved order naming a rail that no longer exists, a rail added by an
 * update the saved order has never seen, a guest dragging a list that hides
 * half the rails — and none of that is reachable from a component test.
 */

/** Anything orderable by key: the shell's nav items, in practice. */
interface Keyed {
  key: string;
}

/**
 * `items` rearranged to match `order`. Keys in `order` that no longer exist are
 * ignored, and — the case that matters after an update adds a page — an item the
 * saved order has never seen stays with the neighbour it ships below instead of
 * falling to the bottom of the rail, where the brewer would never spot it.
 *
 * An empty `order` means "never rearranged", so the built-in order stands.
 */
export function applyNavOrder<T extends Keyed>(items: T[], order: string[]): T[] {
  if (order.length === 0) return items;
  const rank = new Map(order.map((key, i) => [key, i] as const));
  // The rank of the last item we saw that the saved order does know about;
  // anything unlisted inherits it, which puts it directly below that item.
  let anchor = -1;
  const ranked = items.map((item) => {
    const own = rank.get(item.key);
    if (own != null) {
      anchor = own;
      return { item, rank: own, unlisted: 0 };
    }
    return { item, rank: anchor, unlisted: 1 };
  });
  // Array#sort is stable, so items sharing an anchor keep their built-in order.
  ranked.sort((a, b) => a.rank - b.rank || a.unlisted - b.unlisted);
  return ranked.map((r) => r.item);
}

/**
 * `order` with `key` lifted out and dropped where `overKey` sits — dragged down
 * it lands below that row, dragged up it lands above, which is how the gesture
 * reads either way.
 *
 * Keys, not indices, because the row being dragged over is one of the rails
 * *this session can see*: a guest's sidebar hides four of them, and the saved
 * order has to keep carrying the hidden ones or signing in as an admin again
 * would find them gone.
 */
export function moveNavKey(order: string[], key: string, overKey: string): string[] {
  const from = order.indexOf(key);
  const to = order.indexOf(overKey);
  if (from === -1 || to === -1 || from === to) return order;
  const next = order.filter((k) => k !== key);
  // Both directions insert at `to`: dragging down, removing the key first
  // shifted the target up one, which is exactly the "below it" slot.
  next.splice(to, 0, key);
  return next;
}
