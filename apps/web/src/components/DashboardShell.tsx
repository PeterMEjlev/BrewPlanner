import { Link } from 'react-router-dom';
import { api } from '../api';
import { canControl, useAuth } from '../auth';
import {
  BellIcon,
  ChecklistIcon,
  ClockIcon,
  HistoryIcon,
  HomeIcon,
  KegIcon,
  MonitorIcon,
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
  return (
    <div
      className={`flex min-h-screen bg-zinc-950 text-zinc-100 ${
        fit ? 'xl:h-screen xl:overflow-hidden' : ''
      }`}
    >
      <Sidebar active={active} alertCount={alertCount} lastUpdate={lastUpdate} />
      <div className={`min-w-0 flex-1 ${fit ? 'xl:h-screen xl:overflow-hidden' : ''}`}>
        {children}
      </div>
    </div>
  );
}

function Sidebar({
  active,
  alertCount,
  lastUpdate,
}: {
  active: ShellPage;
  alertCount: number;
  lastUpdate?: string | null;
}): JSX.Element {
  const { auth, refresh } = useAuth();

  // Guests are read-only and can't open the Brew System, Settings or History
  // pages (History reveals who changed what, so it stays admin-only), so drop
  // those rails entirely; the kiosk/LAN and admins see the full nav.
  const controllable = canControl(auth);
  const navItems = controllable
    ? NAV
    : NAV.filter(
        (item) =>
          item.page !== 'brewSystem' && item.page !== 'settings' && item.page !== 'history',
      );

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/95 md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="text-3xl font-bold uppercase tracking-tight text-white">
          Konfus
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const isActive = item.page === active;
          const badge = item.key === 'alerts' && alertCount > 0 ? alertCount : undefined;
          return (
            <Link key={item.key} to={item.to} className="block">
              <NavRow Icon={item.Icon} label={item.label} active={isActive} badge={badge} />
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

function NavRow({
  Icon,
  label,
  active,
  badge,
}: {
  Icon: (props: { className?: string }) => JSX.Element;
  label: string;
  active: boolean;
  badge?: number;
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
      {badge != null && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-zinc-950">
          {badge}
        </span>
      )}
    </span>
  );
}
