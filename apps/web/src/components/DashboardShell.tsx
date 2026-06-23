import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import { isUnknownContents } from '../kegs';
import {
  BellIcon,
  ChecklistIcon,
  ClockIcon,
  CloseIcon,
  HistoryIcon,
  HomeIcon,
  KegIcon,
  MonitorIcon,
  MoreIcon,
  SettingsIcon,
  SlidersIcon,
  TodoIcon,
} from './icons';
import { relativeTime } from '../util';

/** Which Overview-shell page is currently showing (drives nav highlight). */
export type ShellPage =
  | 'overview'
  | 'devices'
  | 'brewSystem'
  | 'alerts'
  | 'settings'
  | 'kegs'
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
  { key: 'kegs', label: 'Kegs', Icon: KegIcon, to: '/kegs', page: 'kegs' },
  { key: 'alerts', label: 'Alerts', Icon: BellIcon, to: '/alerts', page: 'alerts' },
  { key: 'devices', label: 'Devices', Icon: MonitorIcon, to: '/devices', page: 'devices' },
  { key: 'brewSystem', label: 'Brew System', Icon: SlidersIcon, to: '/brew-system', page: 'brewSystem' },
  { key: 'checklists', label: 'Checklists', Icon: ChecklistIcon, to: '/admin', page: 'checklists' },
  { key: 'todos', label: 'To-Do', Icon: TodoIcon, to: '/todos', page: 'todos' },
  { key: 'history', label: 'History', Icon: HistoryIcon, to: '/history', page: 'history' },
  { key: 'settings', label: 'Settings', Icon: SettingsIcon, to: '/settings', page: 'settings' },
];

/**
 * The four destinations that get their own tab in the phone bottom bar; the rest
 * fold into a "More" sheet. These mirror the top of the desktop sidebar, the
 * spots a brewer reaches for most when glancing at their phone.
 */
const BOTTOM_BAR_PAGES: ShellPage[] = ['overview', 'kegs', 'alerts', 'devices'];

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
 */
let cachedFleet: FleetStatus | null = null;
let cachedKegStatus: KegStatus | null = null;
let cachedTodoCount: number | null = null;

/**
 * Poll the device fleet so the Devices nav item can show an online/total count
 * and a health dot. Lives in the shell (not a page) because the nav is global,
 * so the badge stays accurate on every screen.
 */
function useFleetStatus(): FleetStatus | null {
  const [fleet, setFleet] = useState<FleetStatus | null>(cachedFleet);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const devices = await api.listDevices();
        if (!cancelled) {
          cachedFleet = { online: devices.filter((d) => d.online).length, total: devices.length };
          setFleet(cachedFleet);
        }
      } catch {
        // Keep the last known counts through a transient failure.
      }
    };
    void load();
    const id = setInterval(() => void load(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return fleet;
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
  const [kegs, setKegs] = useState<KegStatus | null>(cachedKegStatus);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const data = await api.getKegs();
        if (!cancelled) {
          cachedKegStatus = {
            filled: data.filter((k) => !isUnknownContents(k.contents)).length,
            total: data.length,
          };
          setKegs(cachedKegStatus);
        }
      } catch {
        // Keep the last known counts through a transient failure.
      }
    };
    void load();
    const id = setInterval(() => void load(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return kegs;
}

/**
 * Poll the to-do list so the To-Do nav item can show how many tasks are still
 * open (not ticked off), matching the count shown on the To-Do page itself.
 */
function useOpenTodoCount(): number | null {
  const [count, setCount] = useState<number | null>(cachedTodoCount);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const todos = await api.listTodos();
        if (!cancelled) {
          cachedTodoCount = todos.filter((t) => !t.done).length;
          setCount(cachedTodoCount);
        }
      } catch {
        // Keep the last known count through a transient failure.
      }
    };
    void load();
    const id = setInterval(() => void load(), FLEET_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return count;
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
      item.page !== 'brewSystem' && item.page !== 'settings' && item.page !== 'history',
  );
}

/**
 * The persistent desktop chrome: a left nav rail plus the page content. Used by
 * the Overview and the Devices list. Section items (Fermenter, Alerts) scroll to
 * a region of the Overview, navigating there first if we're on another page.
 */
export function DashboardShell({
  active,
  alertCount = 0,
  lastUpdate,
  fit = false,
  children,
}: {
  active: ShellPage;
  /** Badge shown on the Alerts nav item. */
  alertCount?: number;
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
  useEscapeToOverview(active);
  useArrowPageNav(active);
  return (
    <div
      className={`flex min-h-screen bg-zinc-950 text-zinc-100 ${
        fit ? 'xl:h-screen xl:overflow-hidden' : ''
      }`}
    >
      <Sidebar
        active={active}
        alertCount={alertCount}
        fleet={fleet}
        kegs={kegs}
        openTodos={openTodos}
        lastUpdate={lastUpdate}
      />
      {/* Below `md` the sidebar is hidden, so leave room for the fixed bottom bar
          (it would otherwise cover the last cards of a scrolling page). */}
      <div
        className={`min-w-0 flex-1 pb-16 md:pb-0 ${
          fit ? 'xl:h-screen xl:overflow-hidden' : ''
        }`}
      >
        {children}
      </div>
      <BottomNav active={active} alertCount={alertCount} fleet={fleet} lastUpdate={lastUpdate} />
    </div>
  );
}

function Sidebar({
  active,
  alertCount,
  fleet,
  kegs,
  openTodos,
  lastUpdate,
}: {
  active: ShellPage;
  alertCount: number;
  fleet: FleetStatus | null;
  kegs: KegStatus | null;
  openTodos: number | null;
  lastUpdate?: string | null;
}): JSX.Element {
  const { auth, refresh } = useAuth();

  // Guests are read-only and can't open the Brew System, Settings or History
  // pages (History reveals who changed what, so it stays admin-only), so drop
  // those rails entirely; the kiosk/LAN and admins see the full nav.
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
  lastUpdate,
}: {
  active: ShellPage;
  alertCount: number;
  fleet: FleetStatus | null;
  lastUpdate?: string | null;
}): JSX.Element {
  const { auth, refresh } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const nav = visibleNav(canControl(auth));

  const tabs = BOTTOM_BAR_PAGES.map((page) => nav.find((item) => item.page === page)).filter(
    (item): item is NavItem => item != null,
  );
  const moreItems = nav.filter((item) => !BOTTOM_BAR_PAGES.includes(item.page));
  // Highlight "More" while one of its pages is open, so the active section is
  // never left without a lit tab.
  const moreActive = moreItems.some((item) => item.page === active);

  // A tab navigation should dismiss the sheet; so should leaving for `md`+.
  useEffect(() => {
    if (!moreOpen) return;
    const mq = window.matchMedia('(min-width: 768px)');
    const close = (): void => setMoreOpen(false);
    mq.addEventListener('change', close);
    return () => mq.removeEventListener('change', close);
  }, [moreOpen]);

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}

      {moreOpen && (
        <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)] md:hidden">
          <div className="flex items-center justify-between px-5 pb-2 pt-4">
            <span className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              More
            </span>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              aria-label="Close menu"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          <nav className="space-y-1 px-3 pb-2">
            {moreItems.map((item) => (
              <Link key={item.key} to={item.to} className="block" onClick={() => setMoreOpen(false)}>
                <NavRow Icon={item.Icon} label={item.label} active={item.page === active} />
              </Link>
            ))}
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
                    setMoreOpen(false);
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
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-zinc-800 bg-zinc-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {tabs.map((item) => {
          const badge = item.key === 'alerts' && alertCount > 0 ? alertCount : undefined;
          const dot = item.key === 'devices' && fleet ? fleetDotColor(fleet) : undefined;
          return (
            <Link key={item.key} to={item.to} className="min-w-0 flex-1">
              <BottomTab
                Icon={item.Icon}
                label={item.label}
                active={item.page === active}
                badge={badge}
                dot={dot}
              />
            </Link>
          );
        })}
        <button type="button" onClick={() => setMoreOpen((v) => !v)} className="min-w-0 flex-1">
          <BottomTab Icon={MoreIcon} label="More" active={moreActive || moreOpen} />
        </button>
      </nav>
    </>
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
        <Icon className="h-6 w-6" />
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
      <Icon className="h-5 w-5 shrink-0" />
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
