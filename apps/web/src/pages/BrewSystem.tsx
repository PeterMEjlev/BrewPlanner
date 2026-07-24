import { BrewingPanel } from '../components/brewsystem/BrewingPanel';
import { DashboardShell } from '../components/DashboardShell';

/**
 * View and control the physical brewing system (the brew-system-v3 Pi),
 * proxied through this server over the LAN. The panel mirrors the rig's own
 * main screen: three pots, two pumps, and the brew timer.
 */
export function BrewSystemPage(): JSX.Element {
  return (
    <DashboardShell active="brewSystem">
      <main className="w-full max-w-[1580px] px-5 py-5">
        <BrewingPanel />
      </main>
    </DashboardShell>
  );
}
