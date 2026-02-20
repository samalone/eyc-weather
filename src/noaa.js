/**
 * NOAA CO-OPS Tides & Currents API client.
 *
 * Provides a generic fetch helper for any station/product, plus a
 * purpose-built daily cache for hi/lo tide predictions (Pawtuxet Cove).
 */

import { toLocalDate, toNoaaDate } from './dates.js';

// ── Station IDs ─────────────────────────────────────────────────────────────

/** Providence Visibility — wind, visibility, temp, pressure, humidity */
export const STATION_PROVIDENCE_VIS = '8453662';

/** Providence — water level, air temperature */
export const STATION_PROVIDENCE = '8454000';

/** Pawtuxet Cove — tide predictions (closest to EYC) */
const STATION_PAWTUXET = '8453767';

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

// ── Tide prediction curve (Providence, daily cache) ────────────────────────

let curveCache = {
  /** Eastern-local date string (YYYY-MM-DD) the cached data covers */
  date: null,
  /** @type {{ time: string, height: number }[]} */
  curve: [],
};

/**
 * Return today's full 6-minute-interval tide prediction curve for Providence.
 * Cached per calendar day.
 *
 * @returns {Promise<{ time: string, height: number }[]>}
 */
export async function getTideCurve() {
  const today = toLocalDate(new Date());

  if (curveCache.date === today && curveCache.curve.length) {
    return curveCache.curve;
  }

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`[noaa] Fetching tide curve for ${today}`);

  const json = await fetchNoaa({
    begin_date: toNoaaDate(now),
    end_date: toNoaaDate(tomorrow),
    station: STATION_PROVIDENCE,
    product: 'predictions',
    datum: 'MLLW',
  });

  if (!json?.predictions?.length) {
    throw new Error('NOAA response contained no tide curve predictions');
  }

  // Filter to today only (the 2-day fetch may include some of tomorrow)
  const curve = json.predictions
    .filter((p) => p.t.startsWith(today))
    .map((p) => ({
      time: p.t.replace(' ', 'T'),
      height: parseFloat(p.v),
    }));

  curveCache = { date: today, curve };
  console.log(`[noaa] Cached tide curve: ${curve.length} points for ${today}`);

  return curve;
}

// ── Tide predictions (daily cache) ──────────────────────────────────────────

let predictionCache = {
  /** Eastern-local date string (YYYY-MM-DD) the cached data covers */
  date: null,
  /** @type {{ time: string, height: number, type: 'H'|'L' }[]} */
  predictions: [],
};

/**
 * Return today's hi/lo tide predictions for Pawtuxet Cove, fetching from
 * NOAA if the cache is stale (date rolled over).
 *
 * @returns {Promise<{ time: string, height: number, type: 'H'|'L' }[]>}
 */
export async function getTidePredictions() {
  const today = toLocalDate(new Date());

  if (predictionCache.date === today && predictionCache.predictions.length) {
    return predictionCache.predictions;
  }

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`[noaa] Fetching tide predictions for ${today}`);

  // Start from yesterday so the tide clock always has a previous
  // high/low event to bracket the current time, even right after midnight.
  const json = await fetchNoaa({
    begin_date: toNoaaDate(yesterday),
    end_date: toNoaaDate(tomorrow),
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
