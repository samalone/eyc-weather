/**
 * Shared date/time helpers for Eastern-local timestamps.
 *
 * NOAA returns times in US-Eastern local time (lst_ldt), and the
 * frontend displays everything in Eastern.  These helpers ensure the
 * server produces correct Eastern dates/times regardless of the
 * system timezone (important when running in Docker/UTC).
 */

/** IANA timezone for all local-time operations. */
export const TZ = 'America/New_York';

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" in America/New_York,
 * matching the NOAA local-time timestamp format.
 */
export function toLocalIso(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Return the Eastern-local date string "YYYY-MM-DD" for a Date object.
 */
export function toLocalDate(date) {
  return toLocalIso(date).slice(0, 10);
}

/**
 * Format a Date as "YYYYMMDD" in America/New_York (for NOAA API params).
 */
export function toNoaaDate(date) {
  return toLocalDate(date).replace(/-/g, '');
}

/**
 * Return the current time as a local ISO string for comparison.
 */
export function nowLocal() {
  return toLocalIso(new Date());
}
