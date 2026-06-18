import { DashboardShell } from '../components/DashboardShell';

/**
 * View and control the physical brewing system. Blank for now — the status
 * panels and controls land here later.
 */
export function BrewSystemPage(): JSX.Element {
  return (
    <DashboardShell active="brewSystem">
      <main className="w-full max-w-[1580px] px-5 py-5">
        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-50">Brew System</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            View the status of the brewing system and control it.
          </p>
        </div>
      </main>
    </DashboardShell>
  );
}
