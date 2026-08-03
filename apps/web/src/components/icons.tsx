/**
 * Monochrome line icons drawn inline (the project has no icon dependency). All
 * use `currentColor`, so colour and size come from the surrounding text classes
 * (e.g. `text-zinc-300`, `h-5 w-5`) — that's how the sidebar renders inactive
 * items grey and the active item white.
 */

interface IconProps {
  className?: string;
  /** Inline styles — mainly to set `color`, which the icons draw with (currentColor). */
  style?: React.CSSProperties;
}

function Svg({ className, style, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      style={style}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/**
 * The app's accent gradient as an SVG paint server, defined once per document.
 *
 * `currentColor` can only ever be a flat colour, so an icon drawn in the accent
 * has to reference a gradient by id instead. SVG resolves `url(#…)` against the
 * whole document rather than the `<svg>` it appears in, so this one hidden
 * definition serves every icon on the page — render it once, near the root.
 *
 * Point an icon at it with the `icon-accent` class (see index.css). The stops
 * are the accent the primary buttons use, `from-[#f87a68] to-[#e0463f]`, run
 * corner to corner to match `bg-gradient-to-br`.
 *
 * `userSpaceOnUse` over the 24×24 viewBox every icon here shares, rather than
 * the default objectBoundingBox: a gradient in bounding-box units is not
 * painted at all when the box has no width or height, and these icons are full
 * of dead-straight strokes — the speech bubble's lines, the flask's neck — that
 * have exactly that. In bounding-box units those strokes silently disappear.
 */
export function IconAccentGradient(): JSX.Element {
  return (
    <svg width="0" height="0" aria-hidden className="absolute" focusable="false">
      <defs>
        <linearGradient id="icon-accent" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0%" stopColor="#f87a68" />
          <stop offset="100%" stopColor="#e0463f" />
        </linearGradient>
      </defs>
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
 * Speech bubble, for the Bruce nav item. Bruce is a chat you type in first and
 * a voice you talk to second, so the rail shows a bubble rather than a mic —
 * MicIcon is still used where the voice service itself is meant.
 */
export function ChatIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      {/* Body spans x 3–21, so the bubble sits centred in the 24-unit box. */}
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      <path d="M7 8h10" />
      <path d="M7 12h6" />
    </Svg>
  );
}

/** Microphone, for the Bruce voice-assistant nav item. */
export function MicIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </Svg>
  );
}

/** Microphone with a line through it — muted, in a browser voice call. */
export function MicOffIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 9V6a3 3 0 0 1 6 0v3m0 3a3 3 0 0 1-4.5 2.6" />
      <path d="M5 11a7 7 0 0 0 10.5 6.05M19 11a6.9 6.9 0 0 1-.8 3.2" />
      <path d="M12 18v3" />
      <path d="M4 3l16 18" />
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
  style,
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
      style={style}
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

/** A wrench: the Operations heading, and the Tools rail in the sidebar. */
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

/** A board's SoC — for the Raspberry Pis themselves, as opposed to the sensors on them. */
export function ChipIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
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

/** An open recipe book — the Recipes nav item. */
export function BookIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 6.5 4 4v14l8 2.5" />
      <path d="M12 6.5 20 4v14l-8 2.5" />
      <path d="M12 6.5v14" />
    </Svg>
  );
}

/** Right-pointing chevron; rotate it 90° to mark an open disclosure. */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  );
}

/** Globe, for the Bruce chat's web-search switch. */
export function GlobeIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      {/* The two meridians that read as a globe rather than a target. */}
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
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

/** A clock face with a rewind arrow — the change-history tab. */
export function HistoryIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
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

/**
 * Brew Sessions: a boil kettle with steam coming off it. Deliberately a vessel
 * rather than a calendar — the log is a list of brews, and a calendar would read
 * as scheduling something rather than recording it.
 */
export function BrewKettleIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 3c0 1-1 1.2-1 2.2S9 6.6 9 7.6" />
      <path d="M13 3c0 1-1 1.2-1 2.2s1 1.4 1 2.4" />
      <path d="M4 10h16" />
      <path d="M5 10h14l-1.1 9.2A2 2 0 0 1 15.9 21H8.1a2 2 0 0 1-2-1.8Z" />
      <path d="M20 12h1.2a1.3 1.3 0 0 1 0 2.6H19.7" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M 10.31 5.21 L 9.77 3.07 L 14.23 3.07 L 13.69 5.21 L 15.61 6.0 L 16.74 4.11 L 19.89 7.26 L 18.0 8.39 L 18.79 10.31 L 20.93 9.77 L 20.93 14.23 L 18.79 13.69 L 18.0 15.61 L 19.89 16.74 L 16.74 19.89 L 15.61 18.0 L 13.69 18.79 L 14.23 20.93 L 9.77 20.93 L 10.31 18.79 L 8.39 18.0 L 7.26 19.89 L 4.11 16.74 L 6.0 15.61 L 5.21 13.69 L 3.07 14.23 L 3.07 9.77 L 5.21 10.31 L 6.0 8.39 L 4.11 7.26 L 7.26 4.11 L 8.39 6.0 Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** Three dots — the phone bottom-bar "More" overflow tab. */
export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** An X / close mark for dismissing the phone "More" sheet. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
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

/** A droplet: the water meter, and the dilution tool. */
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

/**
 * A test vial with a liquid line — the hydrometer tool. Its own icon rather
 * than the flask above, which the water calculator sits next to on the same
 * rail: a hydrometer is the thing you float in a sample tube, and two flasks
 * would have been two of the same picture.
 */
export function HydrometerIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 3h8" />
      <path d="M9 3v14a3 3 0 0 0 6 0V3" />
      <path d="M9 14h6" />
    </Svg>
  );
}

/** Bubbles rising in a glass — the carbonation tool. */
export function CarbonationIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 12c0-1.5.5-3 2-4" />
      <path d="M14 16c0 1.5-.5 3-2 4" />
      <path d="M12 8v1" />
      <path d="M12 15v1" />
    </Svg>
  );
}

// --- Music (brewery speaker) ------------------------------------------------

/** A musical note — the kiosk home shortcut into the now-playing screen. */
export function MusicIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M9 18V6l11-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </Svg>
  );
}

/** A filled play triangle for the transport controls. */
export function PlayIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 5v14l11-7z" fill="currentColor" />
    </Svg>
  );
}

/** Two filled bars — pause. */
export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="7" y="5" width="3.5" height="14" rx="0.8" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Skip-to-next (a triangle against a bar). */
export function SkipNextIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 5v14l10-7z" fill="currentColor" />
      <rect x="17" y="5" width="2.6" height="14" rx="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Skip-to-previous (a bar against a triangle). */
export function SkipPrevIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="4.4" y="5" width="2.6" height="14" rx="0.8" fill="currentColor" stroke="none" />
      <path d="M18 5v14L8 12z" fill="currentColor" />
    </Svg>
  );
}

/** A speaker — the now-playing placeholder when there's no album art. */
export function SpeakerIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <circle cx="12" cy="14" r="3.5" />
      <circle cx="12" cy="6.5" r="0.6" fill="currentColor" />
    </Svg>
  );
}

/** A low-volume speaker (for the volume slider end-cap). */
export function VolumeIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
    </Svg>
  );
}

/**
 * Three dots rising in turn — Bruce is working on something.
 *
 * Lives here rather than on the Bruce page because both ends of the app show
 * it: the chat's progress bubble, and the sidebar's Bruce tab while an answer
 * is still coming (see bruceActivity.ts). Inherits its colour, so the caller
 * decides whether it reads as ordinary work or as "he's out on the web".
 *
 * The motion is all in `.thinking-dot` (index.css), stagger included — these
 * are three plain spans in order, and the stylesheet does the rest. `h-1` dots
 * were too small to read as moving in a nav row, hence 1.5.
 */
export function ThinkingDots({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-end gap-1 ${className}`} aria-hidden>
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
      <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}
