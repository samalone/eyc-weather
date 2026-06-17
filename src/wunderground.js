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

/** Tolerance for a PWS clock running ahead; beyond this, reject as bogus. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Wind trail window — match NOAA's 1-hour wind history. */
const WIND_WINDOW_MS = 60 * 60 * 1000;

/**
 * Minimum wind speed (knots) for a sample to count toward a recalibration.
 * Below this, vane direction is dominated by noise, so light-wind samples
 * would only pollute the offset estimate.
 */
const MIN_CALIB_SPEED_KT = 5;

/**
 * Minimum matched sample pairs for a usable recalibration. Guards against a
 * one- or two-sample fit, whose resultant-length confidence is trivially high
 * yet meaningless.
 */
const MIN_CALIB_SAMPLES = 3;

/**
 * How close in time a WU sample and a reference sample must be to be paired
 * for recalibration. Both sources report every few minutes, so a 7-minute
 * window reliably finds the nearest neighbour without matching across a gap.
 */
const MATCH_TOLERANCE_MS = 7 * 60 * 1000;

/**
 * Runtime correction applied to WU wind directions, in degrees, plus the
 * provenance of how it was derived.
 *
 * Why this is runtime state and not a constant: the KRICRANS68 vane has a
 * friction set-screw that slips, so its heading picks up an unpredictable —
 * but, between slips, *constant* — rotational offset. The "Recalibrate" page
 * estimates that offset by comparing the PWS against the trusted NOAA station
 * during a steady breeze (see computeRecalibration) and stores it here. The
 * value lives only in this running process; a restart returns to uncalibrated
 * (offset 0, direction shown speed-only) and the offset must be re-derived.
 * That is intentional — there is no durable place to trust a stale calibration
 * across a re-slip. The real fix is still mechanical: tighten the set-screw.
 *
 * `calibratedAt === null` means uncalibrated: offset is 0 (a no-op) and the
 * frontend keeps the PWS direction hidden (speed-only).
 */
let calibration = {
  offsetDeg: 0,
  /** @type {string | null} ISO timestamp of the last applied calibration */
  calibratedAt: null,
  /** @type {number | null} resultant length r ∈ [0,1] — agreement of samples */
  confidence: null,
  /** @type {number | null} matched sample pairs used */
  sampleCount: null,
  /** @type {number | null} reference (NOAA) vector-mean direction at cal time */
  referenceMeanDir: null,
  /** @type {number | null} PWS raw vector-mean direction at cal time */
  pwsMeanDirRaw: null,
  /** @type {number | null} mean PWS wind speed (kt) during the calibration */
  meanSpeedKt: null,
};

/** Apply the current calibration offset, wrapping into [0, 360). Null-safe. */
function correctWindDir(deg) {
  // Treat '' like null: Number('') is 0, which would masquerade as a real
  // due-north reading (NOAA/WU send numeric fields as possibly-empty strings).
  if (deg == null || deg === '') return null;
  const num = Number(deg);
  if (Number.isNaN(num)) return null;
  return ((num + calibration.offsetDeg) % 360 + 360) % 360;
}

/**
 * Parse an Eastern-naive timestamp ("YYYY-MM-DDTHH:MM[:SS]", no offset — the
 * basis NOAA's lst_ldt and toEasternNaive both use) into milliseconds.
 *
 * We append 'Z' and parse as if UTC. The absolute value is therefore wrong by
 * the Eastern UTC offset, but identically so for every timestamp, so it
 * cancels when we only ever take *differences* between two such values (as the
 * recalibration pairing does). This keeps matching deterministic regardless of
 * the server's timezone, with no DST handling needed inside a 1-hour window.
 */
function easternNaiveToMs(naive) {
  return Date.parse(`${naive}Z`);
}

/** Vector (circular) mean of a list of directions in degrees. */
function vectorMeanDeg(anglesDeg) {
  let sumSin = 0;
  let sumCos = 0;
  for (const a of anglesDeg) {
    const r = (a * Math.PI) / 180;
    sumSin += Math.sin(r);
    sumCos += Math.cos(r);
  }
  const n = anglesDeg.length || 1;
  const dir = ((Math.atan2(sumSin, sumCos) * 180) / Math.PI + 360) % 360;
  return { dir, r: Math.hypot(sumSin, sumCos) / n };
}

/** Mean of a numeric array (0 for empty). */
function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Number(v), but null/undefined/'' → NaN. NOAA and WU report numeric fields as
 * strings and can send an empty string for a missing reading; plain Number('')
 * is 0, which would silently inject a bogus 0° direction or 0-kt speed. NaN
 * lets the recalibration filters reject the sample instead of trusting a fake 0.
 */
function numOrNaN(v) {
  if (v == null || v === '') return NaN;
  return Number(v);
}

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

/**
 * Cache for the RAW WU history records. Both the corrected wind trail and the
 * recalibration preview read from here, so the WU history endpoint is hit at
 * most once per TTL no matter how often the (public) preview is requested —
 * preventing preview traffic from burning the WU rate/daily quota.
 */
let rawWindCache = {
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

/**
 * Convert a UTC timestamp ("…Z") to an Eastern wall-clock string without an
 * offset ("YYYY-MM-DDTHH:MM:SS"), matching NOAA's lst_ldt format. The wind
 * compass merges both sources and sorts by this string; keeping the same
 * naive-local basis means the trails stay aligned for any viewer timezone.
 */
const EASTERN_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});
function toEasternNaive(utcString) {
  // Build the string from parts rather than a locale-formatted string, which
  // is locale/ICU-independent and avoids fragile string surgery.
  const p = {};
  for (const part of EASTERN_PARTS_FMT.formatToParts(new Date(utcString))) {
    p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
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
  // returning the last known observation. Also reject readings dated in the
  // future (a PWS clock skewed ahead would otherwise pass as "fresh").
  const obsMs = Date.parse(obs.obsTimeUtc);
  const age = Date.now() - obsMs;
  if (Number.isNaN(obsMs) || age > STALE_MS || age < -CLOCK_SKEW_MS) {
    console.warn(
      `[wu] Station ${stationId}: observation timestamp out of range `
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
    windDirection: correctWindDir(obs.winddir),
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

  // Negative-cache errors too (not just offline): a hard failure — 401 bad
  // key, 429 rate-limit, 5xx, network reject — must not re-hit WU on every
  // request, or it would compound a rate-limit problem. Fall back to NWS.
  let data = null;
  try {
    data = await fetchCurrentObservation();
  } catch (err) {
    console.error('[wu] conditions fetch failed:', err.message);
  }
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
 * Fetch the last hour of rapid wind observations as RAW records
 * ({ easternNaive, dirRaw, speed, gust }) — directions uncorrected, speeds in
 * knots. Shared by the compass trail (which applies the calibration offset)
 * and recalibration (which needs the raw vane headings).
 *
 * Returns `[]` when WU is disabled (no key) or the station is offline (no
 * recent observations).
 *
 * @returns {Promise<object[]>}
 */
async function fetchWuRawWindRecords() {
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

  // Filter to the last hour FIRST — the endpoint returns a full day (~288
  // points) but only ~12 are in-window, so we skip parsing/formatting the 95%
  // we'd discard. Keep the parsed ms on each survivor to sort without re-parsing.
  // Directions here are RAW (uncorrected) — recalibration needs them that way.
  return (json.observations ?? [])
    .map((obs) => ({ obs, ms: Date.parse(obs.obsTimeUtc) }))
    .filter(({ ms }) => !Number.isNaN(ms) && ms >= cutoff)
    .sort((a, b) => a.ms - b.ms)
    .map(({ obs }) => {
      const imp = obs.imperial ?? {};
      return {
        // Eastern wall-clock time (no offset) to match NOAA's lst_ldt format,
        // so both sources sort consistently regardless of the viewer's TZ.
        easternNaive: toEasternNaive(obs.obsTimeUtc),
        dirRaw: numOrNaN(obs.winddirAvg),
        speed: mphToKnots(imp.windspeedAvg) ?? 0,
        gust: mphToKnots(imp.windgustHigh ?? imp.windgustAvg),
      };
    });
}

/**
 * Return the raw WU history records, cached for CACHE_TTL_MS. Shared by the
 * corrected wind trail and the recalibration preview so the upstream WU
 * history endpoint is hit at most once per TTL. Errors are negative-cached
 * (returns []), matching getWuWind — callers fall back gracefully.
 */
async function getWuRawWindRecords() {
  const now = Date.now();
  if (rawWindCache.fetchedAt && (now - rawWindCache.fetchedAt) < CACHE_TTL_MS) {
    return rawWindCache.data;
  }
  let data = [];
  try {
    data = await fetchWuRawWindRecords();
  } catch (err) {
    console.error('[wu] raw wind fetch failed:', err.message);
  }
  rawWindCache = { data, fetchedAt: now };
  return data;
}

/**
 * Fetch the last hour of rapid wind observations and normalize them into the
 * same shape the wind compass consumes for NOAA stations
 * ({ time, s, g, d, dr }, speeds in knots), applying the calibration offset.
 *
 * Records with no usable direction are dropped rather than coerced to 0°:
 * once a calibration is active the PWS is plotted on the compass, where a
 * fake due-north segment would corrupt the trail. Their speed is lost from the
 * trail, but the compass is a direction plot and missing-direction WU samples
 * are rare.
 */
async function fetchWindHistory() {
  const raw = await getWuRawWindRecords();
  const out = [];
  for (const r of raw) {
    const dir = correctWindDir(r.dirRaw);
    if (dir == null) continue;
    const speed = r.speed ?? 0;
    out.push({
      time: r.easternNaive,
      s: speed,
      // Fall back to the speed (zero-length gust) rather than 0, which would
      // draw the gust spoke pointing inward past the speed point.
      g: r.gust ?? speed,
      d: dir,
      dr: compassLabel(dir),
    });
  }
  return out;
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

  // Negative-cache errors (see getWuConditions): drop the trail on failure
  // rather than re-hitting a possibly rate-limited endpoint every refresh.
  let data = [];
  try {
    data = await fetchWindHistory();
  } catch (err) {
    console.error('[wu] wind fetch failed:', err.message);
  }
  windCache = { data, fetchedAt: now };
  console.log(`[wu] Cached wind trail: ${data.length} observations`);
  return data;
}

// ── Wind direction recalibration ───────────────────────────────────────────

/**
 * Estimate the PWS wind-direction offset by comparing the EYC PWS against a
 * trusted reference station (NOAA Providence) over the last hour.
 *
 * Method (per-sample, robust to a wind shift mid-window): each PWS sample is
 * paired with the nearest reference sample in time; pairs where either station
 * is below MIN_CALIB_SPEED_KT are dropped (light wind = noisy direction); the
 * offset is the circular mean of (referenceDir − pwsRawDir) across the pairs.
 * The resultant length r ∈ [0,1] is returned as `confidence`: near 1 means the
 * per-sample differences agree tightly (a clean constant offset); low means the
 * wind was variable or the two sites genuinely disagreed — recalibrate during a
 * steady, strong breeze for a trustworthy result.
 *
 * Does NOT mutate state — callers preview the result, then apply it explicitly.
 *
 * @param {{time: string, d: number|string, s: number|string}[]} referenceObs
 *   Reference wind observations (NOAA `wind` product shape: Eastern-naive
 *   `time`, direction `d` in degrees, speed `s` in knots).
 * @param {object[]} [pwsRecords]  Raw PWS records (defaults to a live fetch);
 *   injectable for testing — shape from fetchWuRawWindRecords().
 * @returns {Promise<object>} preview — `{ ok, offsetDeg, confidence,
 *   sampleCount, referenceMeanDir(+Label/Speed), pwsMeanDirRaw(+Label/Speed),
 *   windowMinutes, minSpeedKt, current }`, or `{ ok: false, reason, ... }`.
 */
export async function computeRecalibration(referenceObs, pwsRecords) {
  const wu = pwsRecords ?? await getWuRawWindRecords();

  if (wu.length === 0) {
    return {
      ok: false,
      reason: 'No PWS wind observations available — the station may be '
        + 'offline or the API key missing.',
      windowMinutes: WIND_WINDOW_MS / 60000,
      minSpeedKt: MIN_CALIB_SPEED_KT,
      minSamples: MIN_CALIB_SAMPLES,
      sampleCount: 0,
      current: getCalibration(),
    };
  }

  const ref = (referenceObs ?? [])
    .map((o) => ({
      ms: easternNaiveToMs(o.time),
      dir: numOrNaN(o.d),
      speed: numOrNaN(o.s),
    }))
    .filter((o) => Number.isFinite(o.ms) && Number.isFinite(o.dir));

  const pairs = [];
  for (const w of wu) {
    if (!Number.isFinite(w.dirRaw)) continue;
    if (!Number.isFinite(w.speed) || w.speed < MIN_CALIB_SPEED_KT) continue;
    const wms = easternNaiveToMs(w.easternNaive);

    // Nearest reference sample in time.
    let best = null;
    let bestDt = Infinity;
    for (const r of ref) {
      const dt = Math.abs(r.ms - wms);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    if (!best || bestDt > MATCH_TOLERANCE_MS) continue;
    // Speed gate uses Number.isFinite so a missing/NaN speed can't slip through
    // (NaN < MIN is false, which would otherwise admit the sample).
    if (!Number.isFinite(best.speed) || best.speed < MIN_CALIB_SPEED_KT) continue;

    pairs.push({
      pwsDir: w.dirRaw, pwsSpeed: w.speed,
      refDir: best.dir, refSpeed: best.speed,
    });
  }

  const base = {
    windowMinutes: WIND_WINDOW_MS / 60000,
    minSpeedKt: MIN_CALIB_SPEED_KT,
    minSamples: MIN_CALIB_SAMPLES,
    sampleCount: pairs.length,
    current: getCalibration(),
  };

  // Require a handful of samples: with a single pair the resultant length is
  // trivially 1.0 ("100% confidence"), which would badly mislead the operator.
  if (pairs.length < MIN_CALIB_SAMPLES) {
    return {
      ok: false,
      reason: `Only ${pairs.length} PWS/reference sample(s) above `
        + `${MIN_CALIB_SPEED_KT} kt in the last ${base.windowMinutes} min `
        + `(need ${MIN_CALIB_SAMPLES}). Try again during a steadier, `
        + 'stronger breeze.',
      ...base,
    };
  }

  // Offset = circular mean of the per-sample (reference − PWS) differences;
  // its resultant length r is the confidence (1 = the offset is dead constant).
  const fit = vectorMeanDeg(pairs.map((p) => p.refDir - p.pwsDir));
  const offsetDeg = fit.dir;
  const confidence = fit.r;

  const refMean = vectorMeanDeg(pairs.map((p) => p.refDir));
  const pwsMean = vectorMeanDeg(pairs.map((p) => p.pwsDir));

  return {
    ok: true,
    offsetDeg,
    confidence,
    referenceMeanDir: refMean.dir,
    referenceMeanDirLabel: compassLabel(refMean.dir),
    referenceMeanSpeedKt: mean(pairs.map((p) => p.refSpeed)),
    pwsMeanDirRaw: pwsMean.dir,
    pwsMeanDirRawLabel: compassLabel(pwsMean.dir),
    pwsMeanSpeedKt: mean(pairs.map((p) => p.pwsSpeed)),
    ...base,
  };
}

/**
 * Current calibration state for the frontend. `active` is true once an offset
 * has been applied (vs. the uncalibrated default, where direction is hidden).
 */
export function getCalibration() {
  return {
    active: calibration.calibratedAt != null,
    offsetDeg: calibration.offsetDeg,
    calibratedAt: calibration.calibratedAt,
    confidence: calibration.confidence,
    sampleCount: calibration.sampleCount,
    referenceMeanDir: calibration.referenceMeanDir,
    pwsMeanDirRaw: calibration.pwsMeanDirRaw,
    meanSpeedKt: calibration.meanSpeedKt,
  };
}

/**
 * Apply a calibration from a (validated) preview. Stamps `calibratedAt` and
 * invalidates the cached wind trail so the new offset shows on the next fetch.
 *
 * The confidence/sampleCount/mean fields are stored as operator-reviewed
 * provenance from the preview — they are not re-derived here, so they describe
 * the data the operator saw, not a fresh sample.
 *
 * @param {object} preview  A successful computeRecalibration result.
 * @returns {object} the new getCalibration()
 * @throws if preview.offsetDeg is not a finite number.
 */
export function applyCalibration(preview) {
  const raw = Number(preview?.offsetDeg);
  if (!Number.isFinite(raw)) {
    throw new Error('applyCalibration: offsetDeg must be a finite number');
  }
  const offsetDeg = ((raw % 360) + 360) % 360;
  calibration = {
    offsetDeg,
    calibratedAt: new Date().toISOString(),
    confidence: preview.confidence ?? null,
    sampleCount: preview.sampleCount ?? null,
    referenceMeanDir: preview.referenceMeanDir ?? null,
    pwsMeanDirRaw: preview.pwsMeanDirRaw ?? null,
    meanSpeedKt: preview.pwsMeanSpeedKt ?? null,
  };
  windCache.fetchedAt = 0; // force the corrected trail to rebuild
  console.log(
    `[wu] Wind direction recalibrated: offset ${offsetDeg.toFixed(1)}° `
    + `(n=${calibration.sampleCount}, r=${(calibration.confidence ?? 0).toFixed(2)})`,
  );
  return getCalibration();
}

/** Clear the calibration back to uncalibrated (offset 0, direction hidden). */
export function resetCalibration() {
  calibration = {
    offsetDeg: 0,
    calibratedAt: null,
    confidence: null,
    sampleCount: null,
    referenceMeanDir: null,
    pwsMeanDirRaw: null,
    meanSpeedKt: null,
  };
  windCache.fetchedAt = 0; // force the trail to rebuild without the offset
  console.log('[wu] Wind direction calibration reset (offset 0)');
  return getCalibration();
}
