import { useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  BellIcon,
  ChecklistIcon,
  ClockIcon,
  FermenterIcon,
  HomeIcon,
  KegIcon,
  MonitorIcon,
  SettingsIcon,
} from './icons';
import { relativeTime } from '../util';

/** Which Overview-shell page is currently showing (drives nav highlight). */
export type ShellPage = 'overview' | 'devices' | 'settings';

type IconComponent = (props: { className?: string }) => JSX.Element;

interface RouteItem {
  kind: 'route';
  key: string;
  label: string;
  Icon: IconComponent;
  to: string;
  /** Marks this item active when the page matches. */
  page?: ShellPage;
}

interface SectionItem {
  kind: 'section';
  key: string;
  label: string;
  Icon: IconComponent;
  /** Element id to scroll to on the Overview. */
  section: string;
}

type NavItem = RouteItem | SectionItem;

const NAV: NavItem[] = [
  { kind: 'route', key: 'overview', label: 'Overview', Icon: HomeIcon, to: '/', page: 'overview' },
  { kind: 'section', key: 'fermenter', label: 'Fermenter', Icon: FermenterIcon, section: 'fermenter' },
  { kind: 'route', key: 'kegs', label: 'Kegs', Icon: KegIcon, to: '/kiosk/kegs' },
  { kind: 'section', key: 'alerts', label: 'Alerts', Icon: BellIcon, section: 'alerts' },
  { kind: 'route', key: 'devices', label: 'Devices', Icon: MonitorIcon, to: '/devices', page: 'devices' },
  { kind: 'route', key: 'checklists', label: 'Checklists', Icon: ChecklistIcon, to: '/admin' },
  { kind: 'route', key: 'settings', label: 'Settings', Icon: SettingsIcon, to: '/settings', page: 'settings' },
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
  const location = useLocation();
  const navigate = useNavigate();

  const goToSection = useCallback(
    (id: string) => {
      if (location.pathname === '/') {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        navigate(`/#${id}`);
      }
    },
    [location.pathname, navigate],
  );

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/95 md:flex">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="text-3xl font-bold uppercase tracking-tight text-white">
          Konfus
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const isActive = item.kind === 'route' && item.page === active;
          const badge = item.key === 'alerts' && alertCount > 0 ? alertCount : undefined;
          const inner = (
            <NavRow Icon={item.Icon} label={item.label} active={isActive} badge={badge} />
          );
          return item.kind === 'route' ? (
            <Link key={item.key} to={item.to} className="block">
              {inner}
            </Link>
          ) : (
            <button
              key={item.key}
              type="button"
              onClick={() => goToSection(item.section)}
              className="block w-full"
            >
              {inner}
            </button>
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
