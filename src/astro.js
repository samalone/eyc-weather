/**
 * Astronomical event calculations using SunCalc.
 *
 * Computes nautical dawn/dusk and moonrise/moonset for EYC's location.
 * Results are cached per calendar day and returned as Eastern-local-time
 * strings matching the format used by NOAA tide predictions.
 */

import SunCalc from 'suncalc';
import { toLocalIso, toLocalDate } from './dates.js';

const EYC_LAT = 41.777;
const EYC_LON = -71.3925;

// Re-export for callers that only need these from astro.js
export { nowLocal } from './dates.js';

// ── Cached daily computation ───────────────────────────────────────────────

let astroCache = { date: null, events: [] };

/**
 * Return today's nautical dawn and dusk as Eastern-local ISO strings.
 * Useful for marking daylight/night on the tide graph.
 *
 * @returns {{ dawn: string|null, dusk: string|null }}
 */
export function getDaylight() {
  // Ensure the cache is populated
  getAstroEvents();
  const today = toLocalDate(new Date());
  const dawn = astroCache.events.find(
    (e) => e.label === 'Nautical dawn' && e.time.startsWith(today),
  );
  const dusk = astroCache.events.find(
    (e) => e.label === 'Nautical dusk' && e.time.startsWith(today),
  );
  return { dawn: dawn?.time ?? null, dusk: dusk?.time ?? null };
}

/**
 * Return astronomical events (nautical dawn/dusk, moonrise/moonset) for
 * today and tomorrow.  Each event has `{ time, label }` where `time` is
 * an Eastern-local ISO string ("YYYY-MM-DDTHH:MM").
 *
 * Cached per calendar day (events don't change within a day).
 *
 * @returns {{ time: string, label: string }[]}
 */
export function getAstroEvents() {
  const today = toLocalDate(new Date());
  if (astroCache.date === today && astroCache.events.length) {
    return astroCache.events;
  }

  console.log(`[astro] Computing events for ${today}`);

  const events = [];

  // Compute for today and tomorrow to have enough future events
  for (let offset = 0; offset < 2; offset++) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(12, 0, 0, 0); // noon as SunCalc reference point

    const sun = SunCalc.getTimes(d, EYC_LAT, EYC_LON);
    const moon = SunCalc.getMoonTimes(d, EYC_LAT, EYC_LON);

    if (sun.nauticalDawn instanceof Date && !isNaN(sun.nauticalDawn)) {
      events.push({ time: toLocalIso(sun.nauticalDawn), label: 'Nautical dawn' });
    }
    if (sun.nauticalDusk instanceof Date && !isNaN(sun.nauticalDusk)) {
      events.push({ time: toLocalIso(sun.nauticalDusk), label: 'Nautical dusk' });
    }
    if (moon.rise) {
      events.push({ time: toLocalIso(moon.rise), label: 'Moonrise' });
    }
    if (moon.set) {
      events.push({ time: toLocalIso(moon.set), label: 'Moonset' });
    }
  }

  // Sort chronologically
  events.sort((a, b) => a.time.localeCompare(b.time));

  astroCache = { date: today, events };
  console.log(`[astro] Cached ${events.length} events for ${today}`);

  return events;
}
