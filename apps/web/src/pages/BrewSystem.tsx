import { BrewingPanel } from '../components/brewsystem/BrewingPanel';
import { DashboardShell } from '../components/DashboardShell';
import { FitScale } from '../components/FitScale';

/**
 * View and control the physical brewing system (the brew-system-v3 Pi),
 * proxied through this server over the LAN. The panel mirrors the rig's own
 * main screen: three pots, two pumps, and the brew timer.
 *
 * Desktop/laptop (`xl`+) pins the page to exactly one viewport height and hands
 * the panel to [FitScale] with `maxScale={1}`: full size while it fits, shrunk
 * uniformly when it doesn't, never enlarged. Turning REG on grows a pot card by
 * a Target row plus a Set Temperature slider (~150px), which used to push the
 * bottom of the panel below the fold; the scaler absorbs that instead.
 *
 * `fill` gives any leftover height to the panel rather than centring it as empty
 * margin, so the pot row stretches and the pumps/timer sit at the bottom of the
 * screen — the rig's own layout, where the pot row is `flex: 1`.
 *
 * The height lock lives on `<main>` rather than `DashboardShell`'s `fit` prop
 * on purpose — `fit` also locks the *phone* layout to one screen, and here the
 * stacked single-column panel is meant to flow and scroll. Below `xl` FitScale
 * is a transparent pass-through, so small screens keep that layout untouched.
 *
 * On a phone the panel restyles rather than scales: the gutter tightens here and
 * the card modules retune their type scale below 640px (see BrewingPanel.module.css).
 * Shrinking the kiosk layout uniformly would have taken its controls well under
 * a usable touch target, which is the one thing a brew session cannot give up.
 */
export function BrewSystemPage(): JSX.Element {
  return (
    <DashboardShell active="brewSystem">
      <main className="w-full max-w-[1580px] px-3 py-3 sm:px-5 sm:py-5 xl:h-screen xl:overflow-hidden">
        <FitScale maxScale={1} minScale={0.6} fill>
          <BrewingPanel />
        </FitScale>
      </main>
    </DashboardShell>
  );
}
