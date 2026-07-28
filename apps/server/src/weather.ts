import type { OutdoorTemperature } from '@checklist/shared';

/**
 * Today's daytime average outdoor temperature where this brewery is, which is
 * what a new recipe starts its grain temperature from: the sacks sit at
 * whatever the day has been, not at this exact minute, so a sunrise-to-sunset
 * average reads closer to that than a single current reading would. The
 * brewer can still type over it — this only saves the usual case of looking
 * it up by hand.
 *
 * Open-Meteo needs no key and no account, which is what makes it usable on the
 * Pi; the reading is cached so a page open doesn't mean a request, and a failed
 * lookup is cached briefly too so an offline Pi retries occasionally rather than
 * on every recipe. Because the average is "today's", the cache simply expires
 * into a new day's figure the same way it expires into a fresher one within a
 * day — no separate midnight handling needed.
 */

/** 2820 Gentofte, Denmark. */
const BREWERY = {
  latitude: 55.75,
  longitude: 12.55,
  label: 'Gentofte, Denmark',
  timezone: 'Europe/Copenhagen',
};

const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_SECONDS ?? 30 * 60) * 1000;
/** How long a failed lookup is remembered, so being offline stays cheap. */
const FAILURE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;

let cached: { reading: OutdoorTemperature | null; fetchedAt: number } | null = null;
let inFlight: Promise<OutdoorTemperature | null> | null = null;

/**
 * Today's daytime average, or null when it can't be reached — the caller
 * treats that as "no default", never as a temperature.
 */
export async function outdoorTemperature(): Promise<OutdoorTemperature | null> {
  const ttl = cached?.reading ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.reading;
  inFlight ??= fetchTemperature()
    .catch(() => null)
    .then((reading) => {
      cached = { reading, fetchedAt: Date.now() };
      return reading;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * The average of today's hourly readings between sunrise and sunset. Open-Meteo
 * has no "daytime mean" of its own — `daily=temperature_2m_mean` covers the
 * full 24 hours, night included — so this reads the hourly series and the
 * day's sunrise/sunset alongside it and averages the hours that fall between
 * them. Past hours in that series are the model's analysis and the remaining
 * hours of today are its forecast, which is the usual way a "today" figure is
 * built before the day is over.
 */
async function fetchTemperature(): Promise<OutdoorTemperature | null> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(BREWERY.latitude));
  url.searchParams.set('longitude', String(BREWERY.longitude));
  url.searchParams.set('hourly', 'temperature_2m');
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', BREWERY.timezone);
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Weather lookup failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    hourly?: { time?: string[]; temperature_2m?: number[] };
    daily?: { time?: string[]; sunrise?: string[]; sunset?: string[] };
  };
  const times = body.hourly?.time ?? [];
  const temps = body.hourly?.temperature_2m ?? [];
  const sunrise = body.daily?.sunrise?.[0];
  const sunset = body.daily?.sunset?.[0];
  const today = body.daily?.time?.[0];
  if (!sunrise || !sunset || times.length === 0) return null;
  const isDaytimeReading = (time: string, temp: number | undefined): temp is number =>
    time >= sunrise && time <= sunset && typeof temp === 'number' && Number.isFinite(temp);
  const daytime = temps.filter((temp, i) => isDaytimeReading(times[i]!, temp));
  if (daytime.length === 0) return null;
  const mean = daytime.reduce((sum, temp) => sum + temp, 0) / daytime.length;
  return {
    temperatureC: Math.round(mean * 10) / 10,
    observedAt: today ?? new Date().toISOString().slice(0, 10),
    location: BREWERY.label,
  };
}
