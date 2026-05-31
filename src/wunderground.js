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
/** Rapid (≈5 min) observations for the current day — used for the wind trail. */
const WU_HISTORY_BASE = 'https://api.weather.com/v2/pws/observations/all/1day';
const DEFAULT_STATION_ID = 'KRICRANS68';

/** Cache TTL — WU PWS stations report every few minutes; 5 min matches NWS. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** An observation older than this is treated as "station offline". */
const STALE_MS = 30 * 60 * 1000;

/** Wind trail window — match NOAA's 1-hour wind history. */
const WIND_WINDOW_MS = 60 * 60 * 1000;

// ── Cache state ──────────────────────────────────────────────────────────

let cache = {
  /** @type {object | null} */
  data: null,
  /** @type {number} Date.now() when last fetched */
  fetchedAt: 0,
};

/** Separate cache for the wind trail (different endpoint, larger payload). */
let windCache = {
  /** @type {object[]} */
  data: [],
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

/** 16-point compass label for a direction in degrees. */
const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];
function compassLabel(deg) {
  if (deg == null) return '';
  return COMPASS_16[Math.round(deg / 22.5) % 16];
}

/** Read API key + station from the environment (call-time, not load-time). */
function wuConfig() {
  return {
    apiKey: process.env.WUNDERGROUND_API_KEY,
    stationId: process.env.WUNDERGROUND_STATION_ID || DEFAULT_STATION_ID,
  };
}

// ── Fetch & parse ──────────────────────────────────────────────────────────

/**
 * Fetch the latest WU observation and normalize it.
 *
 * @returns {Promise<object | null>} normalized observation, or null when WU
 *   is disabled (no key), offline (no/empty/stale data), or errors.
 */
async function fetchCurrentObservation() {
  const { apiKey, stationId } = wuConfig();

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

// ── Wind trail ───────────────────────────────────────────────────────────

/**
 * Fetch the last hour of rapid wind observations and normalize them into the
 * same shape the wind compass consumes for NOAA stations
 * ({ time, s, g, d, dr }, speeds in knots).
 *
 * Returns `[]` when WU is disabled (no key) or the station is offline (no
 * recent observations) so the source simply drops off the compass.
 *
 * @returns {Promise<object[]>}
 */
async function fetchWindHistory() {
  const { apiKey, stationId } = wuConfig();
  if (!apiKey) return [];

  const url = `${WU_HISTORY_BASE}?stationId=${encodeURIComponent(stationId)}`
    + `&format=json&units=e&numericPrecision=decimal`
    + `&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`WU history API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const cutoff = Date.now() - WIND_WINDOW_MS;

  return (json.observations ?? [])
    .map((obs) => {
      const imp = obs.imperial ?? {};
      const dir = obs.winddirAvg;
      return {
        ms: Date.parse(obs.obsTimeUtc),
        time: obs.obsTimeUtc,
        s: mphToKnots(imp.windspeedAvg) ?? 0,
        g: mphToKnots(imp.windgustHigh ?? imp.windgustAvg) ?? 0,
        d: dir ?? 0,
        dr: compassLabel(dir),
      };
    })
    // Drop pre-window points and anything missing a usable timestamp.
    .filter((o) => !Number.isNaN(o.ms) && o.ms >= cutoff)
    .sort((a, b) => a.ms - b.ms)
    .map(({ ms, ...keep }) => keep);
}

/**
 * Return the last hour of WU wind observations, fetching if the cache is
 * stale.  Empty array when WU is disabled/offline.
 *
 * @returns {Promise<object[]>}
 */
export async function getWuWind() {
  const now = Date.now();
  if (windCache.fetchedAt && (now - windCache.fetchedAt) < CACHE_TTL_MS) {
    return windCache.data;
  }

  const data = await fetchWindHistory();
  windCache = { data, fetchedAt: now };
  console.log(`[wu] Cached wind trail: ${data.length} observations`);
  return data;
}
