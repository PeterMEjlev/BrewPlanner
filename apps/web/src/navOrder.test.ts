import { describe, expect, it } from 'vitest';
import { applyNavOrder, moveNavKey } from './navOrder';

/**
 * A rearranged sidebar has to survive the things that happen to it later: an
 * update that adds a rail, an update that drops one, and a guest whose sidebar
 * hides four of them. Get any of those wrong and the rail silently loses pages
 * — which looks like the nav is broken, not like a stale preference.
 */

const keys = (items: { key: string }[]): string[] => items.map((i) => i.key);
const items = (...ks: string[]): { key: string }[] => ks.map((key) => ({ key }));

describe('applyNavOrder', () => {
  it('leaves the built-in order alone when nothing was rearranged', () => {
    const built = items('overview', 'kegs', 'devices');
    expect(applyNavOrder(built, [])).toBe(built);
  });

  it('rearranges to the saved order', () => {
    expect(keys(applyNavOrder(items('overview', 'kegs', 'devices'), ['devices', 'overview', 'kegs'])))
      .toEqual(['devices', 'overview', 'kegs']);
  });

  it('ignores saved keys whose rail no longer exists', () => {
    expect(keys(applyNavOrder(items('overview', 'kegs'), ['kegs', 'retired', 'overview'])))
      .toEqual(['kegs', 'overview']);
  });

  it('keeps a rail the saved order has never seen next to its built-in neighbour', () => {
    // 'music' shipped between kegs and devices in a later release; the saved
    // order predates it, so it should follow kegs rather than drop to the end.
    const built = items('overview', 'kegs', 'music', 'devices');
    expect(keys(applyNavOrder(built, ['devices', 'kegs', 'overview'])))
      .toEqual(['devices', 'kegs', 'music', 'overview']);
  });

  it('keeps a brand-new first rail at the top', () => {
    // Nothing ranked sits above it, so it anchors before everything else.
    expect(keys(applyNavOrder(items('brandNew', 'overview', 'kegs'), ['kegs', 'overview'])))
      .toEqual(['brandNew', 'kegs', 'overview']);
  });

  it('keeps several unseen rails in their built-in order', () => {
    expect(keys(applyNavOrder(items('overview', 'a', 'b', 'kegs'), ['kegs', 'overview'])))
      .toEqual(['kegs', 'overview', 'a', 'b']);
  });

  it('drops the rails a guest may not open without disturbing the rest', () => {
    // The saved order carries every rail; the guest's sidebar is the subset.
    const guestRails = items('overview', 'kegs', 'devices');
    expect(keys(applyNavOrder(guestRails, ['devices', 'bruce', 'kegs', 'settings', 'overview'])))
      .toEqual(['devices', 'kegs', 'overview']);
  });
});

describe('moveNavKey', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('drops a row dragged down below the row it landed on', () => {
    expect(moveNavKey(order, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('drops a row dragged up above the row it landed on', () => {
    expect(moveNavKey(order, 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves a row to either end', () => {
    expect(moveNavKey(order, 'c', 'a')).toEqual(['c', 'a', 'b', 'd']);
    expect(moveNavKey(order, 'a', 'd')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('keeps the hidden rails a guest never saw', () => {
    // 'bruce' and 'settings' aren't on a guest's sidebar, so they can't be
    // dragged — but they must still be in the order that gets saved.
    expect(moveNavKey(['overview', 'bruce', 'kegs', 'settings'], 'kegs', 'overview'))
      .toEqual(['kegs', 'overview', 'bruce', 'settings']);
  });

  it('does nothing when a key is unknown or the row was dropped on itself', () => {
    expect(moveNavKey(order, 'a', 'a')).toBe(order);
    expect(moveNavKey(order, 'a', 'gone')).toBe(order);
    expect(moveNavKey(order, 'gone', 'a')).toBe(order);
  });
});
