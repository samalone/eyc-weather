/**
 * Weather Underground (WU) PWS API client.
 *
 * Fetches the current observation from the Edgewood Yacht Club personal
 * weather station (KRICRANS68 by default) and normalizes it into the same
 * shape the conditions card consumes. WU gives us hyper-local temperature,
 * wind, humidity, dew point, pressure and precipitation, but NO sky
 * condition / icon / text description — those still come from NWS.
 *
 * The station has been known to go offline. When that happens the API
 * returns no observation (or a stale one), so callers should treat a `null`
 * return as "WU unavailable, fall back to NWS".
 *
 * Configuration (environment):
 *   WUNDERGROUND_API_KEY    — required; without it WU is disabled (returns null)
 *   WUNDERGROUND_STATION_ID — optional; defaults to KRICRANS68
 */

const WU_BASE = 'https://api.weather.com/v2/pws/observations/current';
const DEFAULT_STATION_ID = 'KRICRANS68';

/** Cache TTL — WU PWS stations report every few minutes; 5 min matches NWS. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** An observation older than this is treated as "station offline". */
const STALE_MS = 30 * 60 * 1000;

// ── Cache state ──────────────────────────────────────────────────────────

let cache = {
  /** @type {object | null} */
  data: null,
  /** @type {number} Date.now() when last fetched */
  fetchedAt: 0,
};

/** Warn about a missing API key only once, not on every request. */
let warnedMissingKey = false;

// ── Unit conversion helpers ────────────────────────────────────────────────

/** mph → knots.  Returns null if input is null/undefined. */
function mphToKnots(mph) {
  if (mph == null) return null;
  return mph * 0.868976;
}

// ── Fetch & parse ──────────────────────────────────────────────────────────

/**
 * Fetch the latest WU observation and normalize it.
 *
 * @returns {Promise<object | null>} normalized observation, or null when WU
 *   is disabled (no key), offline (no/empty/stale data), or errors.
 */
async function fetchCurrentObservation() {
  const apiKey = process.env.WUNDERGROUND_API_KEY;
  const stationId = process.env.WUNDERGROUND_STATION_ID || DEFAULT_STATION_ID;

  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn('[wu] WUNDERGROUND_API_KEY not set — WU source disabled');
      warnedMissingKey = true;
    }
    return null;
  }

  const url = `${WU_BASE}?stationId=${encodeURIComponent(stationId)}`
    + `&format=json&units=e&numericPrecision=decimal`
    + `&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);

  // 204 = no current observation (station offline)
  if (res.status === 204) {
    console.warn(`[wu] Station ${stationId}: no current observation (204)`);
    return null;
  }

  if (!res.ok) {
    throw new Error(`WU API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const obs = json.observations?.[0];
  if (!obs) {
    console.warn(`[wu] Station ${stationId}: empty observations array`);
    return null;
  }

  // Reject stale data — the station can stop reporting while the API keeps
  // returning the last known observation.
  const obsMs = Date.parse(obs.obsTimeUtc);
  if (Number.isNaN(obsMs) || (Date.now() - obsMs) > STALE_MS) {
    console.warn(
      `[wu] Station ${stationId}: observation is stale `
      + `(${obs.obsTimeUtc}) — treating as offline`,
    );
    return null;
  }

  const imp = obs.imperial ?? {};
  const temp = imp.temp;

  // Feels-like: wind chill when cold, heat index when hot, else actual temp.
  // (WU populates windChill/heatIndex with the actual temp when N/A.)
  let feelsLike = temp;
  if (temp != null && temp <= 50 && imp.windChill != null) {
    feelsLike = imp.windChill;
  } else if (temp != null && temp >= 80 && imp.heatIndex != null) {
    feelsLike = imp.heatIndex;
  }

  return {
    source: 'wunderground',
    stationId,
    timestamp: obs.obsTimeUtc,
    temperature: temp ?? null,
    feelsLike: feelsLike ?? null,
    humidity: obs.humidity ?? null,
    windSpeed: mphToKnots(imp.windSpeed),
    windGust: mphToKnots(imp.windGust),
    windDirection: obs.winddir ?? null,
    dewPoint: imp.dewpt ?? null,
    pressure: imp.pressure ?? null,
    precipRate: imp.precipRate ?? null,
    precipTotal: imp.precipTotal ?? null,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Return the current WU observation, fetching if the cache is stale.
 *
 * Returns `null` (cached like a successful result) when WU is disabled or
 * the station is offline, so callers can cleanly fall back to NWS without
 * re-hitting the API every request.
 *
 * @returns {Promise<object | null>}
 */
export async function getWuConditions() {
  const now = Date.now();
  if (cache.fetchedAt && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.data;
  }

  const data = await fetchCurrentObservation();
  cache = { data, fetchedAt: now };

  if (data) {
    console.log(
      `[wu] Cached conditions from ${data.stationId}: `
      + `${data.temperature?.toFixed(0)}°F`,
    );
  }
  return data;
}
