/**
 * National Weather Service (NWS) API client.
 *
 * Fetches current conditions from the nearest NWS observation station
 * (KPVD — TF Green Airport) and a 5-day forecast for the EYC location.
 * Caches results with simple TTLs.
 *
 * The NWS API is free and requires no API key, but does require a
 * descriptive User-Agent header.
 */

const NWS_BASE = 'https://api.weather.gov';
const STATION = 'KPVD';
const USER_AGENT = '(eyc-weather, github.com/samalone/eyc-weather)';

/** EYC coordinates for grid-point / forecast lookups. */
const EYC_LAT = 41.777;
const EYC_LON = -71.3925;

/** Cache TTL in milliseconds.  NWS updates observations roughly every
 *  10 minutes; 5 min keeps the data reasonably fresh without hammering
 *  the API. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Forecast cache TTL — NWS forecasts update every few hours. */
const FORECAST_TTL_MS = 60 * 60 * 1000;

/** Grid-point URL cache TTL — the grid point for a location never changes. */
const GRID_TTL_MS = 24 * 60 * 60 * 1000;

// ── Cache state ──────────────────────────────────────────────────────────

let cache = {
  /** @type {object | null} */
  data: null,
  /** @type {number} Date.now() when last fetched */
  fetchedAt: 0,
};

let forecastCache = { data: null, fetchedAt: 0 };
let gridForecastUrl = null;
let gridResolvedAt = 0;

// ── Unit conversion helpers ──────────────────────────────────────────────

/** Celsius → Fahrenheit.  Returns null if input is null/undefined. */
function cToF(c) {
  if (c == null) return null;
  return c * 9 / 5 + 32;
}

/** km/h → knots.  Returns null if input is null/undefined. */
function kmhToKnots(kmh) {
  if (kmh == null) return null;
  return kmh * 0.539957;
}

// ── Icon URL parser ──────────────────────────────────────────────────────

/**
 * Extract day/night and condition code from an NWS icon URL.
 *
 * URL format:
 *   https://api.weather.gov/icons/land/{day|night}/{condition},{probability}?size=medium
 *   https://api.weather.gov/icons/land/{day|night}/{condition}?size=medium
 *
 * @param {string} iconUrl
 * @returns {{ timeOfDay: string, condition: string }}
 */
function parseIconUrl(iconUrl) {
  if (!iconUrl) return { timeOfDay: 'day', condition: 'skc' };

  const match = iconUrl.match(/\/icons\/land\/(day|night)\/([^?,/]+)/);
  if (!match) return { timeOfDay: 'day', condition: 'skc' };

  return {
    timeOfDay: match[1],
    condition: match[2],
  };
}

// ── Fetch & parse ────────────────────────────────────────────────────────

async function fetchLatestObservation() {
  const url = `${NWS_BASE}/stations/${STATION}/observations/latest`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/geo+json',
    },
  });

  if (!res.ok) {
    throw new Error(`NWS API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const props = json.properties;

  const tempC = props.temperature?.value;
  const windChillC = props.windChill?.value;
  const heatIndexC = props.heatIndex?.value;

  // Feels-like: wind chill in cold, heat index in heat, else actual temp
  let feelsLikeC;
  if (windChillC != null) {
    feelsLikeC = windChillC;
  } else if (heatIndexC != null) {
    feelsLikeC = heatIndexC;
  } else {
    feelsLikeC = tempC;
  }

  const { timeOfDay, condition } = parseIconUrl(props.icon);

  return {
    timestamp: props.timestamp,
    temperature: cToF(tempC),
    feelsLike: cToF(feelsLikeC),
    humidity: props.relativeHumidity?.value ?? null,
    windSpeed: kmhToKnots(props.windSpeed?.value),
    windGust: kmhToKnots(props.windGust?.value),
    textDescription: props.textDescription || '',
    timeOfDay,
    condition,
  };
}

// ── Forecast ─────────────────────────────────────────────────────────

/**
 * Resolve the NWS grid-point forecast URL for EYC's coordinates.
 * Cached for 24 hours (the grid point never changes for a fixed location).
 */
async function getGridForecastUrl() {
  const now = Date.now();
  if (gridForecastUrl && (now - gridResolvedAt) < GRID_TTL_MS) {
    return gridForecastUrl;
  }

  console.log(`[nws] Resolving grid point for ${EYC_LAT},${EYC_LON}`);
  const url = `${NWS_BASE}/points/${EYC_LAT},${EYC_LON}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });

  if (!res.ok) {
    throw new Error(`NWS points API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  gridForecastUrl = json.properties.forecast;
  gridResolvedAt = now;
  console.log(`[nws] Grid forecast URL: ${gridForecastUrl}`);
  return gridForecastUrl;
}

/** Day-of-week abbreviations. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Fetch the NWS forecast and aggregate day/night periods into daily
 * summaries with high/low temperatures and condition codes.
 *
 * @returns {Promise<Array<{date: string, dayName: string, high: number,
 *   low: number|null, condition: string, shortForecast: string}>>}
 */
async function fetchForecast() {
  const forecastUrl = await getGridForecastUrl();
  const res = await fetch(forecastUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' },
  });

  if (!res.ok) {
    throw new Error(`NWS forecast API ${res.status}: ${res.statusText}`);
  }

  const json = await res.json();
  const periods = json.properties.periods;

  // Group periods by calendar date (local date from startTime)
  const byDate = new Map();
  for (const p of periods) {
    // startTime is like "2025-06-15T06:00:00-04:00"
    const dateStr = p.startTime.slice(0, 10);
    if (!byDate.has(dateStr)) {
      byDate.set(dateStr, { day: null, night: null });
    }
    const entry = byDate.get(dateStr);
    if (p.isDaytime) {
      entry.day = p;
    } else {
      entry.night = p;
    }
  }

  // Build daily summaries — skip dates without a daytime period (e.g.
  // today if it's already evening and only a tonight period remains)
  const days = [];
  for (const [dateStr, { day, night }] of byDate) {
    if (!day) continue; // no daytime data — skip
    if (days.length >= 5) break;

    const dt = new Date(dateStr + 'T12:00:00');
    const { condition } = parseIconUrl(day.icon);

    days.push({
      date: dateStr,
      dayName: DAY_NAMES[dt.getUTCDay()],
      high: day.temperature,
      low: night ? night.temperature : null,
      condition,
      shortForecast: day.shortForecast || '',
    });
  }

  return days;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Return current weather conditions, fetching from NWS if the cache is
 * stale.  The first call is lazy (no startup initialization required).
 *
 * @returns {Promise<object>}
 */
export async function getConditions() {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.data;
  }

  console.log('[nws] Fetching latest conditions from KPVD');
  const data = await fetchLatestObservation();
  cache = { data, fetchedAt: now };
  console.log(
    `[nws] Cached conditions: ${data.textDescription}, ${data.temperature?.toFixed(0)}°F`,
  );
  return data;
}

/**
 * Return 5-day forecast, fetching from NWS if the cache is stale.
 *
 * @returns {Promise<Array<object>>}
 */
export async function getForecast() {
  const now = Date.now();
  if (forecastCache.data && (now - forecastCache.fetchedAt) < FORECAST_TTL_MS) {
    return forecastCache.data;
  }

  console.log('[nws] Fetching forecast for EYC');
  const data = await fetchForecast();
  forecastCache = { data, fetchedAt: now };
  console.log(`[nws] Cached ${data.length}-day forecast`);
  return data;
}
