/**
 * NOAA CO-OPS Tides & Currents API client.
 *
 * Provides a generic fetch helper for any station/product, plus a
 * purpose-built daily cache for hi/lo tide predictions (Pawtuxet Cove).
 */

// ── Station IDs ─────────────────────────────────────────────────────────────

/** Providence Visibility — wind, visibility, temp, pressure, humidity */
export const STATION_PROVIDENCE_VIS = '8453662';

/** Providence — water level, air temperature */
export const STATION_PROVIDENCE = '8454000';

/** Pawtuxet Cove — tide predictions (closest to EYC) */
export const STATION_PAWTUXET = '8453767';

// ── API base ────────────────────────────────────────────────────────────────

const NOAA_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

// ── Generic fetch helper ────────────────────────────────────────────────────

/**
 * Fetch data from the NOAA CO-OPS API.
 *
 * @param {Record<string, string>} params  Query parameters (station, product,
 *   date/range/begin_date/end_date, datum, interval, etc.).  `units`,
 *   `time_zone`, and `format` are added automatically if not provided.
 * @returns {Promise<object>}  Parsed JSON response.
 */
export async function fetchNoaa(params) {
  const merged = {
    units: 'english',
    time_zone: 'lst_ldt',
    format: 'json',
    ...params,
  };

  const url = `${NOAA_BASE}?${new URLSearchParams(merged)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`NOAA API ${res.status}: ${res.statusText} — ${url}`);
  }

  const json = await res.json();

  // NOAA returns { error: { message } } on logical errors (bad station, etc.)
  if (json.error) {
    throw new Error(`NOAA API error: ${json.error.message} — ${url}`);
  }

  return json;
}

// ── Tide predictions (daily cache) ──────────────────────────────────────────

let predictionCache = {
  /** ISO date string (YYYY-MM-DD) the cached data covers */
  date: null,
  /** @type {{ time: string, height: number, type: 'H'|'L' }[]} */
  predictions: [],
};

/** Format a Date as YYYYMMDD in local time. */
function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Return today's hi/lo tide predictions for Pawtuxet Cove, fetching from
 * NOAA if the cache is stale (date rolled over).
 *
 * @returns {Promise<{ time: string, height: number, type: 'H'|'L' }[]>}
 */
export async function getTidePredictions() {
  const today = new Date().toISOString().slice(0, 10);

  if (predictionCache.date === today && predictionCache.predictions.length) {
    return predictionCache.predictions;
  }

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`[noaa] Fetching tide predictions for ${today}`);

  const json = await fetchNoaa({
    begin_date: yyyymmdd(now),
    end_date: yyyymmdd(tomorrow),
    station: STATION_PAWTUXET,
    product: 'predictions',
    datum: 'MLLW',
    interval: 'hilo',
  });

  if (!json?.predictions?.length) {
    throw new Error('NOAA response contained no predictions');
  }

  const predictions = json.predictions.map((p) => ({
    time: p.t.replace(' ', 'T'),
    height: parseFloat(p.v),
    type: p.type,
  }));

  predictionCache = { date: today, predictions };
  console.log(`[noaa] Cached ${predictions.length} hi/lo predictions for ${today}`);

  return predictions;
}
