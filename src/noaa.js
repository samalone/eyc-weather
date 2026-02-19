/**
 * NOAA CO-OPS Tides & Currents API client.
 *
 * Fetches tide predictions for Pawtuxet Cove (station 8453767) and caches
 * them in memory.  Predictions are deterministic for a given day, so we
 * only re-fetch when the calendar date rolls over.
 */

const NOAA_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const STATION_PAWTUXET = '8453767';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cache = {
  /** ISO date string (YYYY-MM-DD) the cached data covers */
  date: null,
  /** @type {{ time: string, height: number, type: 'H'|'L' }[]} */
  predictions: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as YYYYMMDD in local time. */
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Build a NOAA API URL for hi/lo tide predictions spanning today and
 * tomorrow (local time) so the frontend always has the next upcoming
 * event even late at night.
 */
function buildUrl() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const params = new URLSearchParams({
    begin_date: yyyymmdd(now),
    end_date: yyyymmdd(tomorrow),
    station: STATION_PAWTUXET,
    product: 'predictions',
    datum: 'MLLW',
    interval: 'hilo',
    units: 'english',
    time_zone: 'lst_ldt',
    format: 'json',
  });

  return `${NOAA_BASE}?${params}`;
}

/**
 * Parse the NOAA JSON response into a clean array.
 *
 * Raw shape:  { predictions: [{ t: "2026-02-19 09:04", v: "4.356", type: "H" }, …] }
 * Output:     [{ time: "2026-02-19T09:04", height: 4.356, type: "H" }, …]
 */
function parsePredictions(json) {
  if (!json?.predictions?.length) {
    throw new Error('NOAA response contained no predictions');
  }

  return json.predictions.map((p) => ({
    // NOAA returns "YYYY-MM-DD HH:MM" — convert to ISO-ish for Date parsing
    time: p.t.replace(' ', 'T'),
    height: parseFloat(p.v),
    type: p.type, // "H" or "L"
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return today's hi/lo tide predictions, fetching from NOAA if the cache
 * is stale (i.e. the date has changed).
 *
 * @returns {Promise<{ time: string, height: number, type: 'H'|'L' }[]>}
 */
export async function getTidePredictions() {
  const today = new Date().toISOString().slice(0, 10);

  if (cache.date === today && cache.predictions.length) {
    return cache.predictions;
  }

  const url = buildUrl();
  console.log(`[noaa] Fetching tide predictions from ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NOAA API returned ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const predictions = parsePredictions(json);

  cache = { date: today, predictions };
  console.log(`[noaa] Cached ${predictions.length} hi/lo predictions for ${today}`);

  return predictions;
}
