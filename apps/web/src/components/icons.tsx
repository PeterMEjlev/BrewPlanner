/**
 * Monochrome line icons drawn inline (the project has no icon dependency). All
 * use `currentColor`, so colour and size come from the surrounding text classes
 * (e.g. `text-zinc-300`, `h-5 w-5`) — that's how the sidebar renders inactive
 * items grey and the active item white.
 */

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      aria-hidden
    >
      {children}
    </svg>
  );
}

// --- Sidebar nav ------------------------------------------------------------

export function HomeIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 11 12 3l9 8" />
      <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
    </Svg>
  );
}

/**
 * Line-art conical fermenter, matching the Pi kiosk's hero icon
 * (KioskHome's FermenterIcon). Own 64-unit viewBox, so it keeps the kiosk's
 * exact proportions while still sizing/colouring from `className`.
 */
export function FermenterIcon({
  className,
  strokeWidth = 4.5,
}: IconProps & { strokeWidth?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      // Heavier than the kiosk's 2.4 because we render small (h-5): this keeps
      // the line weight in step with the other 24-unit dashboard icons. Callers
      // rendering it large (the command-centre header) pass a thinner value.
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      aria-hidden
    >
      {/* top port */}
      <path d="M29 6h6M32 6v5" />
      {/* domed lid + cylindrical body */}
      <path d="M17 18c0-4 6.7-7 15-7s15 3 15 7" />
      <path d="M17 18v18" />
      <path d="M47 18v18" />
      {/* conical bottom */}
      <path d="M17 36l15 19 15-19" />
      {/* butterfly valve */}
      <circle cx="32" cy="45" r="3" />
      {/* legs */}
      <path d="M23 50l-3 8" />
      <path d="M41 50l3 8" />
    </svg>
  );
}

/** A wrench / tool for the Operations heading. */
export function WrenchIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
    </Svg>
  );
}

/** A small hut / building for the Brewery & Utilities heading. */
export function HutIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 11 12 5l8 6" />
      <path d="M6 10v9h12v-9" />
      <path d="M10 19v-5h4v5" />
    </Svg>
  );
}

/** A keg — capped cylinder with a band. */
export function KegIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <ellipse cx="12" cy="5" rx="6" ry="2.2" />
      <path d="M6 5v14c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5" />
      <path d="M6 12c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2" />
    </Svg>
  );
}

export function BellIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Svg>
  );
}

/** A control panel: sliders for the brew-system controls. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </Svg>
  );
}

export function MonitorIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </Svg>
  );
}

export function ChecklistIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="5" y="4" width="14" height="16" rx="2" />
      <path d="M9 3h6v3H9z" />
      <path d="m9 13 2 2 4-4" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  );
}

/** Brand mark: a beer mug. */
export function BeerMugIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 8h9v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8Z" />
      <path d="M15 10h2.5A1.5 1.5 0 0 1 19 11.5v3A1.5 1.5 0 0 1 17.5 16H15" />
      <path d="M8 8V6a3 3 0 0 1 3-3 2.5 2.5 0 0 1 2.5 2.5" />
      <path d="M9 12v5M12 12v5" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </Svg>
  );
}

// --- Fermenter command-centre section icons ---------------------------------

/** A dial pressure gauge / speedometer with a needle. */
export function GaugeIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="m12 13 4-3" />
      <circle cx="12" cy="13" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** A lightning bolt for the power meter. */
export function BoltIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </Svg>
  );
}

/** A droplet for the water meter. */
export function DropletIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
    </Svg>
  );
}

/** A task list for the brewery to-do shortcut. */
export function TodoIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4 6 1 1 2-2" />
      <path d="m4 12 1 1 2-2" />
      <path d="m4 18 1 1 2-2" />
    </Svg>
  );
}

/** A thermometer for the temperature & control section. */
export function ThermometerIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M14 14.76V5a2 2 0 1 0-4 0v9.76a4 4 0 1 0 4 0Z" />
    </Svg>
  );
}

/** An Erlenmeyer flask with a liquid line for the gravity section. */
export function FlaskIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v6l-5 9.5A1 1 0 0 0 5.9 20h12.2a1 1 0 0 0 .9-1.5L14 9V3" />
      <path d="M7.5 14h9" />
    </Svg>
  );
}
