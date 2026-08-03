import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { useBrucePhase } from '../bruceActivity';
import { isUnknownContents } from '../kegs';
import { unregisterPush } from '../push';
import { SHARED, useShared } from '../sharedPoll';
import { usePoll } from '../usePoll';
import {
  BellIcon,
  BookIcon,
  BrewKettleIcon,
  ChatIcon,
  ChecklistIcon,
  ClockIcon,
  HistoryIcon,
  HomeIcon,
  IconAccentGradient,
  KegIcon,
  MonitorIcon,
  SettingsIcon,
  SlidersIcon,
  ThinkingDots,
  TodoIcon,
  WrenchIcon,
} from './icons';
import { relativeTime } from '../util';

/** Which Overview-shell page is currently showing (drives nav highlight). */
export type ShellPage =
  | 'overview'
  | 'devices'
  | 'brewSystem'
  | 'bruce'
  // The calculators page — water, dilution, hydrometer, carbonation. Stays lit
  // whichever of them is showing.
  | 'tools'
  | 'alerts'
  | 'settings'
  | 'kegs'
  // Both the recipe list and a single recipe's brew sheet, so the nav item stays
  // lit while browsing into a recipe.
  | 'recipes'
  // Likewise the brew-session log and a single entry.
  | 'brewSessions'
  | 'checklists'
  | 'todos'
  | 'history';

type IconComponent = (props: { className?: string }) => JSX.Element;

interface NavItem {
  key: string;
  label: string;
  Icon: IconComponent;
  to: string;
  /** Marks this item active when the page matches. */
  page: ShellPage;
}

const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', Icon: HomeIcon, to: '/', page: 'overview' },
  { key: 'brewSystem', label: 'Brew System', Icon: SlidersIcon, to: '/brew-system', page: 'brewSystem' },
  { key: 'recipes', label: 'Recipes', Icon: BookIcon, to: '/recipes', page: 'recipes' },
  { key: 'kegs', label: 'Kegs', Icon: KegIcon, to: '/kegs', page: 'kegs' },
  { key: 'devices', label: 'Devices', Icon: MonitorIcon, to: '/devices', page: 'devices' },
  { key: 'bruce', label: 'Bruce', Icon: ChatIcon, to: '/bruce', page: 'bruce' },
  { key: 'brewSessions', label: 'Brew Sessions', Icon: BrewKettleIcon, to: '/brew-sessions', page: 'brewSessions' },
  { key: 'tools', label: 'Tools', Icon: WrenchIcon, to: '/tools', page: 'tools' },
  { key: 'todos', label: 'To-Do', Icon: TodoIcon, to: '/todos', page: 'todos' },
  { key: 'checklists', label: 'Checklists', Icon: ChecklistIcon, to: '/admin', page: 'checklists' },
  { key: 'history', label: 'History', Icon: HistoryIcon, to: '/history', page: 'history' },
  { key: 'alerts', label: 'Alerts', Icon: BellIcon, to: '/alerts', page: 'alerts' },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon, to: '/settings', page: 'settings' },
];

/**
 * The destinations shown first in the phone bottom bar — the spots a brewer
 * reaches for most when glancing at their phone, and what's visible before any
 * horizontal scrolling. The rest of the nav follows them in the same scrollable
 * strip; only the account/last-update footer lives behind "More".
 */
const BOTTOM_BAR_PAGES: ShellPage[] = ['overview', 'brewSystem', 'recipes', 'kegs'];

/** How often the nav re-checks the fleet's online/total counts. */
const FLEET_POLL_MS = 15_000;

interface FleetStatus {
  online: number;
  total: number;
}

/**
 * Module-level caches of the last polled nav counts, kept alive across shell
 * remounts. The shell remounts on every page navigation, so without these the
 * badges would flash empty and refetch each time you switch pages; seeding the
 * hooks' state from the cache keeps the last known count on screen while the
 * background refresh runs.
 *
 * The badges whose endpoint a page also polls (devices, kegs, alerts, the brew
 * system) have moved to shared channels — see sharedPoll.ts — which hold the
 * same last value *and* collapse the two timers into one. What's left here is
 * the badges nothing else fetches alongside them.
 */
let cachedTodoCount: number | null = null;
/**
 * The phone bottom-bar's horizontal scroll offset, remembered across shell
 * remounts. The shell remounts on every navigation, so without this the
 * scrollable tab strip would jump back to the start each time you tapped a tab.
 */
let cachedNavScrollLeft = 0;

/**
 * Poll the device fleet so the Devices nav item can show an online/total count
 * and a health dot. Lives in the shell (not a page) because the nav is global,
 * so the badge stays accurate on every screen — which is exactly why it shares
 * the fleet channel with whatever page is showing rather than polling its own.
 */
function useFleetStatus(): FleetStatus | null {
  const { data } = useShared(SHARED.devices, api.listDevices, FLEET_POLL_MS);
  return useMemo(
    () => (data ? { online: data.filter((d) => d.online).length, total: data.length } : null),
    [data],
  );
}

/** Dot colour for the fleet's health: green all up, amber some down, red all down. */
function fleetDotColor({ online, total }: FleetStatus): string {
  if (total === 0) return 'bg-zinc-500';
  if (online === total) return 'bg-emerald-400';
  if (online === 0) return 'bg-red-500';
  return 'bg-amber-400';
}

/** Online/total device count with a health dot, for the Devices nav item. */
function FleetBadge({ online, total }: FleetStatus): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums text-zinc-400">
      <span className={`h-2 w-2 rounded-full ${fleetDotColor({ online, total })}`} aria-hidden />
      {online}/{total}
    </span>
  );
}

interface KegStatus {
  filled: number;
  total: number;
}

/**
 * Poll the keg inventory so the Kegs nav item can show a filled/total count.
 * Mirrors {@link useFleetStatus}: lives in the shell so the badge is accurate on
 * every page, and keeps the last counts through a transient fetch failure.
 */
function useKegStatus(): KegStatus | null {
  const { data } = useShared(SHARED.kegs, api.getKegs, FLEET_POLL_MS);
  return useMemo(
    () =>
      data
        ? {
            filled: data.filter((k) => !isUnknownContents(k.contents)).length,
            total: data.length,
          }
        : null,
    [data],
  );
}

/**
 * Poll the to-do list so the To-Do nav item can show how many tasks are still
 * open (not ticked off), matching the count shown on the To-Do page itself.
 */
function useOpenTodoCount(): number | null {
  const [count, setCount] = useState<number | null>(cachedTodoCount);
  usePoll(async (isStale) => {
    try {
      const todos = await api.listTodos();
      if (!isStale()) {
        cachedTodoCount = todos.filter((t) => !t.done).length;
        setCount(cachedTodoCount);
      }
    } catch {
      // Keep the last known count through a transient failure.
    }
  }, FLEET_POLL_MS);
  return count;
}

/**
 * Poll active alerts so the Alerts nav badge shows a live count on *every* page,
 * not only the Overview/Alerts pages that fetch alerts themselves. Lives in the
 * shell (like {@link useFleetStatus}) so the badge is global, and keeps the last
 * count through a transient failure. "Active" = not yet resolved, matching the
 * Overview and Alerts page counts.
 */
function useAlertCount(): number {
  const { data } = useShared(SHARED.alerts, api.listAlerts, FLEET_POLL_MS);
  return useMemo(() => (data ?? []).filter((a) => a.resolvedAt == null).length, [data]);
}

/**
 * The brewing rig's reachability, for the Brew System nav item. `configured` is
 * false when no rig URL is set (a common single-fermenter install) — then the
 * nav says nothing at all, rather than a misleading red "Offline".
 */
interface BrewSystemNavStatus {
  configured: boolean;
  online: boolean;
}

/**
 * Poll the brewing rig so the Brew System nav item can say whether it's up.
 * Lives in the shell like {@link useFleetStatus} so the answer is right on
 * every page, and holds the last value through a blip.
 * The rig is off most of the year, so this is cheap and expected to read offline.
 *
 * On the shared channel, so the Overview's brew-system card — which wants the
 * same payload far more often during a brew session — rides this one request
 * instead of opening a second poll of the rig.
 */
function useBrewSystemStatus(): BrewSystemNavStatus | null {
  const { data } = useShared(SHARED.brewSystem, api.getBrewSystemState, FLEET_POLL_MS);
  return useMemo(
    () => (data ? { configured: data.configured, online: data.online } : null),
    [data],
  );
}

/**
 * The rig's reachability spelled out next to the nav item: green "Online" when
 * it answers, red "Offline" when it doesn't. A word rather than a coloured dot,
 * because the dot needed a hover to tell you which state it meant — and this is
 * the one nav item whose whole page is unusable when the answer is "offline".
 */
function BrewSystemBadge({ online }: BrewSystemNavStatus): JSX.Element {
  return (
    <span className={`text-xs font-semibold ${online ? 'text-emerald-400' : 'text-red-400'}`}>
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

/** Filled/total keg count, for the Kegs nav item. */
function KegBadge({ filled, total }: KegStatus): JSX.Element {
  return (
    <span className="text-xs font-semibold tabular-nums text-zinc-400">
      {filled}/{total}
    </span>
  );
}

/** A neutral pill with a count, for the To-Do nav item. */
function CountBadge({ count }: { count: number }): JSX.Element {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-800 px-1.5 text-xs font-semibold tabular-nums text-zinc-400">
      {count}
    </span>
  );
}

/**
 * Whether a global keyboard shortcut should stand down: another handler already
 * claimed the key, the user is typing in a field, or a modal/dialog is open (it
 * owns its own keys and closes itself first).
 */
function keyShortcutBlocked(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const el = document.activeElement as HTMLElement | null;
  if (
    el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  )
    return true;
  return document.querySelector('[role="dialog"]') != null;
}

/**
 * Pressing Escape on any subpage jumps back to the main dashboard (Overview).
 * Skipped on Overview itself, while typing in a field, and while a dialog is open
 * or another handler has claimed the key (e.g. the keg grid's select mode) — those
 * close/cancel first, so a second Escape then leaves the page.
 */
function useEscapeToOverview(active: ShellPage): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (active === 'overview') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || keyShortcutBlocked(e)) return;
      navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, navigate]);
}

/**
 * Up/Down arrows step through the sidebar's nav items in order, so the whole app
 * is reachable from the keyboard. Wraps top-to-bottom, follows the same guest
 * filtering as the sidebar, and stands down while typing or with a dialog open.
 */
function useArrowPageNav(active: ShellPage): void {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const items = visibleNav(canControl(auth));
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || keyShortcutBlocked(e)) return;
      const current = items.findIndex((item) => item.page === active);
      if (current === -1) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = items[(current + delta + items.length) % items.length];
      if (!next) return;
      e.preventDefault();
      navigate(next.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, items, navigate]);
}

/** Drop the nav rails a read-only guest may not open (matches the sidebar). */
function visibleNav(controllable: boolean): NavItem[] {
  if (controllable) return NAV;
  return NAV.filter(
    (item) =>
      item.page !== 'brewSystem' &&
      item.page !== 'bruce' &&
      item.page !== 'settings' &&
      item.page !== 'history',
  );
}

/**
 * The persistent desktop chrome: a left nav rail plus the page content. Used by
 * the Overview and the Devices list. Section items (Fermenter, Alerts) scroll to
 * a region of the Overview, navigating there first if we're on another page.
 */
export function DashboardShell({
  active,
  lastUpdate,
  fit = false,
  children,
}: {
  active: ShellPage;
  /** ISO timestamp of the most recent device report, for the footer. */
  lastUpdate?: string | null;
  /**
   * Lock the shell to exactly one viewport height at `xl` and up, so the page
   * fills the monitor without a scrollbar (the Overview opts in; the content is
   * responsible for distributing the fixed height). Below `xl` — phones, small
   * windows — the page flows and scrolls as normal.
   */
  fit?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const fleet = useFleetStatus();
  const kegs = useKegStatus();
  const openTodos = useOpenTodoCount();
  const alertCount = useAlertCount();
  const brewSystem = useBrewSystemStatus();
  useEscapeToOverview(active);
  useArrowPageNav(active);
  return (
    // `100dvh`, not `min-h-screen`: on a phone `100vh` is the tall URL-bar-hidden
    // viewport, so a page that exactly fills the visible area still stretched ~75px
    // past it and scrolled into empty background. `dvh` tracks what's on screen
    // (and equals `vh` on desktop, where the two never differ).
    <div
      className={`flex min-h-[100dvh] bg-zinc-950 text-zinc-100 ${
        fit ? 'xl:h-screen xl:overflow-hidden' : ''
      }`}
    >
      {/* The accent paint the active nav icon is drawn with. Once per document,
          above both navs — an SVG gradient is referenced by id, not scoped to
          the <svg> that defines it. */}
      <IconAccentGradient />
      <Sidebar
        active={active}
        alertCount={alertCount}
        fleet={fleet}
        kegs={kegs}
        openTodos={openTodos}
        brewSystem={brewSystem}
        lastUpdate={lastUpdate}
      />
      {/* Below `md` the sidebar is hidden, so: leave room for the fixed bottom
          bar (it would otherwise cover the last cards), and inset the top by the
          safe-area so content clears the status bar / camera cutout on a phone.
          Both fall away at `md`+ where the desktop chrome takes over. */}
      <div
        className={`min-w-0 flex-1 pb-16 pt-[env(safe-area-inset-top)] md:pb-0 md:pt-0 ${
          fit
            ? 'h-[100dvh] overflow-hidden md:h-auto md:overflow-visible xl:h-screen xl:overflow-hidden'
            : ''
        }`}
      >
        {children}
      </div>
      <BottomNav active={active} alertCount={alertCount} fleet={fleet} />
    </div>
  );
}

function Sidebar({
  active,
  alertCount,
  fleet,
  kegs,
  openTodos,
  brewSystem,
  lastUpdate,
}: {
  active: ShellPage;
  alertCount: number;
  fleet: FleetStatus | null;
  kegs: KegStatus | null;
  openTodos: number | null;
  brewSystem: BrewSystemNavStatus | null;
  lastUpdate?: string | null;
}): JSX.Element {
  const { auth, refresh } = useAuth();
  const brucePhase = useBrucePhase();

  // Guests are read-only and can't open the Brew System, Bruce, Settings or
  // History pages (History reveals who changed what, so it stays admin-only),
  // so drop those rails entirely; the kiosk/LAN and admins see the full nav.
  const navItems = visibleNav(canControl(auth));

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/95 md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <Link
          to="/"
          className="text-3xl font-bold uppercase tracking-tight text-white transition hover:text-zinc-300"
        >
          Konfus
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const isActive = item.page === active;
          const badge = item.key === 'alerts' && alertCount > 0 ? alertCount : undefined;
          let accessory: React.ReactNode = undefined;
          if (item.key === 'devices' && fleet)
            accessory = <FleetBadge online={fleet.online} total={fleet.total} />;
          else if (item.key === 'kegs' && kegs)
            accessory = <KegBadge filled={kegs.filled} total={kegs.total} />;
          else if (item.key === 'todos' && openTodos != null && openTodos > 0)
            accessory = <CountBadge count={openTodos} />;
          // Bruce is off working on an answer. Shown on the tab so you can ask
          // him something and go and look at the fermenter without wondering
          // whether he's still at it — the phase's colour says whether he's in
          // the library or out on the web (see bruceActivity.ts).
          else if (item.key === 'bruce' && brucePhase)
            accessory = (
              <ThinkingDots
                className={brucePhase.phase === 'web' ? 'text-sky-400' : 'text-zinc-400'}
              />
            );
          // Say so only once a rig URL is configured — an install with no brewing
          // rig shows nothing rather than a permanent red "Offline".
          else if (item.key === 'brewSystem' && brewSystem?.configured)
            accessory = <BrewSystemBadge {...brewSystem} />;
          return (
            <Link key={item.key} to={item.to} className="block">
              <NavRow
                Icon={item.Icon}
                label={item.label}
                active={isActive}
                badge={badge}
                accessory={accessory}
              />
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-zinc-800 px-5 py-4 text-sm">
        <div className="flex items-center gap-2 text-zinc-500">
          <ClockIcon className="h-4 w-4" />
          <div className="leading-tight">
            <div className="text-zinc-300">{lastUpdate ? relativeTime(lastUpdate) : '—'}</div>
            <div className="text-xs">Last update</div>
          </div>
        </div>
        {auth.user && (
          <div className="flex items-center justify-between gap-2 text-zinc-500">
            <span className="truncate text-zinc-400">{auth.user.username}</span>
            <button
              type="button"
              onClick={async () => {
                // Withdraw this phone's push token first: after the session is
                // gone the call would be refused, and the token would keep
                // buzzing with the next user's notifications.
                await unregisterPush();
                await api.logout();
                await refresh();
              }}
              className="rounded-lg px-2 py-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * The phone-only navigation: a fixed bottom tab bar (hidden at `md`+, where the
 * sidebar takes over). The four primary destinations get a tab each; everything
 * else — plus the last-update stamp and sign-out that live in the sidebar
 * footer — folds into a slide-up "More" sheet.
 */
function BottomNav({
  active,
  alertCount,
  fleet,
}: {
  active: ShellPage;
  alertCount: number;
  fleet: FleetStatus | null;
}): JSX.Element {
  const { auth } = useAuth();
  const nav = visibleNav(canControl(auth));
  const brucePhase = useBrucePhase();
  const scrollRef = useRef<HTMLElement>(null);

  // The primary four lead the strip; the remaining destinations follow in the
  // same row and become reachable by swiping the bar sideways.
  const primary = BOTTOM_BAR_PAGES.map((page) => nav.find((item) => item.page === page)).filter(
    (item): item is NavItem => item != null,
  );
  const tabs = [...primary, ...nav.filter((item) => !BOTTOM_BAR_PAGES.includes(item.page))];

  // Restore the strip's last scroll position (it remounts on every navigation),
  // then only nudge the active tab into view if it ended up off-screen — so
  // tapping a tab you can already see doesn't jump the strip back to the start.
  useLayoutEffect(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    strip.scrollLeft = cachedNavScrollLeft;
    const activeEl = strip.querySelector<HTMLElement>('[data-active="true"]');
    if (activeEl) {
      const a = activeEl.getBoundingClientRect();
      const c = strip.getBoundingClientRect();
      if (a.left < c.left || a.right > c.right) {
        activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      }
    }
  }, [active]);

  return (
      <nav
        ref={scrollRef}
        onScroll={(e) => {
          cachedNavScrollLeft = e.currentTarget.scrollLeft;
        }}
        className="fixed inset-x-0 bottom-0 z-30 flex snap-x overflow-x-auto overscroll-x-contain border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur [-ms-overflow-style:none] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((item) => {
          const badge = item.key === 'alerts' && alertCount > 0 ? alertCount : undefined;
          const dot = item.key === 'devices' && fleet ? fleetDotColor(fleet) : undefined;
          const isActive = item.page === active;
          // Same signal as the sidebar's Bruce row, in the shape this bar has
          // room for: a dot rather than the three-dot animation.
          const busy = item.key === 'bruce' && brucePhase != null;
          return (
            <Link
              key={item.key}
              to={item.to}
              data-active={isActive}
              className="w-[4.5rem] shrink-0 snap-start"
            >
              <BottomTab
                Icon={item.Icon}
                label={item.label}
                active={isActive}
                badge={badge}
                dot={busy ? `animate-pulse ${brucePhase?.phase === 'web' ? 'bg-sky-400' : 'bg-zinc-300'}` : dot}
              />
            </Link>
          );
        })}
      </nav>
  );
}

/** One tab in the phone bottom bar: stacked icon + label, lit white when active. */
function BottomTab({
  Icon,
  label,
  active,
  badge,
  dot,
}: {
  Icon: IconComponent;
  label: string;
  active: boolean;
  badge?: number;
  /** A small status dot on the icon (e.g. fleet health), as a bg-* colour class. */
  dot?: string;
}): JSX.Element {
  return (
    <span
      className={`relative flex flex-col items-center gap-1 px-1 py-2 text-[11px] font-medium transition ${
        active ? 'text-white' : 'text-zinc-400'
      }`}
    >
      <span className="relative">
        {/* Same treatment as the sidebar's active row — this is the same nav,
            just the phone's shape of it. */}
        <Icon className={`h-6 w-6 ${active ? 'icon-accent' : ''}`} />
        {badge != null && (
          <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-zinc-950">
            {badge}
          </span>
        )}
        {dot != null && (
          <span
            className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-zinc-950 ${dot}`}
            aria-hidden
          />
        )}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </span>
  );
}

function NavRow({
  Icon,
  label,
  active,
  badge,
  accessory,
}: {
  Icon: (props: { className?: string }) => JSX.Element;
  label: string;
  active: boolean;
  badge?: number;
  /** A custom right-hand element (e.g. the fleet count); takes priority over `badge`. */
  accessory?: React.ReactNode;
}): JSX.Element {
  return (
    <span
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
        active
          ? 'bg-white/10 text-white'
          : 'text-zinc-300 hover:bg-zinc-800/60 hover:text-white'
      }`}
    >
      {/* The active item's icon is the accent gradient rather than white — the
          label stays white, so the rail reads as one lit row with a coloured
          mark rather than two competing highlights. */}
      <Icon className={`h-5 w-5 shrink-0 ${active ? 'icon-accent' : ''}`} />
      <span className="flex-1 text-left">{label}</span>
      {accessory ??
        (badge != null && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-zinc-950">
            {badge}
          </span>
        ))}
    </span>
  );
}
