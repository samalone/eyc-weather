/**
 * National Weather Service (NWS) API client.
 *
 * Fetches current conditions from the nearest NWS observation station
 * (KPVD — TF Green Airport) and caches the result with a simple TTL.
 *
 * The NWS API is free and requires no API key, but does require a
 * descriptive User-Agent header.
 */

const NWS_BASE = 'https://api.weather.gov';
const STATION = 'KPVD';
const USER_AGENT = '(eyc-weather, github.com/samalone/eyc-weather)';

/** Cache TTL in milliseconds.  NWS updates observations roughly every
 *  10 minutes; 5 min keeps the data reasonably fresh without hammering
 *  the API. */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Cache state ──────────────────────────────────────────────────────────

let cache = {
  /** @type {object | null} */
  data: null,
  /** @type {number} Date.now() when last fetched */
  fetchedAt: 0,
};

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
