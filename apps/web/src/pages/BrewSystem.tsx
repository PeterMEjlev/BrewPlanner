import { BrewingPanel } from '../components/brewsystem/BrewingPanel';
import { DashboardShell } from '../components/DashboardShell';
import { FitScale } from '../components/FitScale';
import { useIsMobile } from '../useIsMobile';

/**
 * View and control the physical brewing system (the brew-system-v3 Pi),
 * proxied through this server over the LAN. The panel mirrors the rig's own
 * main screen: three pots, two pumps, and the brew timer.
 *
 * Both layouts fill exactly one screen; they differ in how.
 *
 * Desktop/laptop (`xl`+) pins the page to one viewport height and hands the
 * panel to [FitScale] with `maxScale={1}`: full size while it fits, shrunk
 * uniformly when it doesn't, never enlarged. Turning REG on grows a pot card by
 * a Target row plus a Set Temperature slider (~150px), which used to push the
 * bottom of the panel below the fold; the scaler absorbs that instead. `fill`
 * gives any leftover height to the panel rather than centring it as empty
 * margin, so the pot row stretches and the pumps/timer sit at the bottom of the
 * screen — the rig's own layout, where the pot row is `flex: 1`.
 *
 * On a phone the panel restyles rather than scales: the card modules retune
 * their type scale below 640px and re-lay each card as a single instrument row
 * (see BrewingPanel.module.css). Shrinking the kiosk layout uniformly would have
 * taken its controls well under a usable touch target, which is the one thing a
 * brew session cannot give up.
 *
 * That left the phone about a third of a screen short of the bottom bar, so the
 * shell's `fit` locks the page to the visible viewport here too and `main` hands
 * that height straight to the panel, which shares it out between the rows. Same
 * bargain as the Overview: no scaling, so the full width is used, and no
 * [FitScale] in the tree at all — below `xl` it was only ever a pass-through
 * wrapper, and a pass-through can't grow. `overflow-y-auto` is the escape hatch
 * for a screen too short for the layout's natural height (a small phone in
 * landscape): it scrolls rather than clipping a control off the bottom.
 */
export function BrewSystemPage(): JSX.Element {
  const isMobile = useIsMobile();
  return (
    <DashboardShell active="brewSystem" fit>
      <main
        className={
          isMobile
            ? // 8px gutter, matching the gap between the cards themselves.
              'flex h-full w-full flex-col overflow-y-auto px-2 py-2'
            : 'w-full max-w-[1580px] px-3 py-3 sm:px-5 sm:py-5 xl:h-screen xl:overflow-hidden'
        }
      >
        {isMobile ? (
          <BrewingPanel />
        ) : (
          <FitScale maxScale={1} minScale={0.6} fill>
            <BrewingPanel />
          </FitScale>
        )}
      </main>
    </DashboardShell>
  );
}
