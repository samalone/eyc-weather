import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import {
  getTidePredictions,
  getTideCurve,
  STATION_PROVIDENCE_VIS,
  STATION_PROVIDENCE,
} from './src/noaa.js';
import { StationCache } from './src/cache.js';
import { getForecast } from './src/nws.js';
import { getCurrentConditions } from './src/conditions.js';
import {
  getWuWind,
  computeRecalibration,
  getCalibration,
  applyCalibration,
  resetCalibration,
} from './src/wunderground.js';
import { getAstroEvents, getDaylight, nowLocal } from './src/astro.js';

/** Pseudo-station id the frontend uses for the EYC Weather Underground PWS. */
const WU_STATION = 'wunderground';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE_PATH = '/eyc-weather';

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ── Observation caches (lazy — fetch on first request, not on startup) ──────

const stationCaches = new Map();

/** Providence Visibility — meteorological observations */
const provVisCacher = new StationCache(STATION_PROVIDENCE_VIS, [
  'wind',
  'visibility',
  'air_temperature',
  'air_pressure',
  'humidity',
]);

/** Providence — water level observations (25h window for tide graph) */
const provCacher = new StationCache(STATION_PROVIDENCE, ['water_level'], {
  productParams: { water_level: { datum: 'MLLW' } },
  windowHours: '25',
});

stationCaches.set(STATION_PROVIDENCE_VIS, provVisCacher);
stationCaches.set(STATION_PROVIDENCE, provCacher);

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Prefix a route path with the BASE_PATH. */
const bp = (path) => `${BASE_PATH}${path}`;

/**
 * Gate a recalibration-mutating request on the shared secret in
 * RECALIBRATE_SECRET (sent as the `X-Recalibrate-Secret` header or a `secret`
 * body field). This is deliberately light security — the worst a bad actor can
 * do is point the PWS wind arrow the wrong way until someone recalibrates — but
 * it stops casual/accidental changes via the unlisted page.
 *
 * Returns true if the request may proceed; otherwise writes the error response
 * and returns false.
 */
function checkRecalibrateSecret(req, res) {
  const expected = process.env.RECALIBRATE_SECRET;
  if (!expected) {
    res.status(503).json({
      error: 'Recalibration is not configured (RECALIBRATE_SECRET is unset).',
    });
    return false;
  }
  const provided = req.get('X-Recalibrate-Secret') ?? req.body?.secret ?? '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: 'Invalid recalibration secret.' });
    return false;
  }
  return true;
}

// Redirect /eyc-weather → /eyc-weather/ so relative URLs resolve correctly
app.use(BASE_PATH, (req, _res, next) => {
  if (req.path === '/' && !req.originalUrl.endsWith('/')) {
    return _res.redirect(301, `${BASE_PATH}/`);
  }
  next();
});

// ── Static files ────────────────────────────────────────────────────────────
app.use(bp('/'), express.static(join(__dirname, 'public'), {
  index: false,
  redirect: false,
}));

/** Serve index.html for the root path. */
app.get(bp('/'), (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

/** Unlisted PWS wind-direction recalibration page. */
app.get(bp('/recalibrate'), (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'recalibrate.html'));
});

// ── API routes ──────────────────────────────────────────────────────────────

/** Tide predictions (hi/lo for Pawtuxet Cove). */
app.get(bp('/api/tides'), async (_req, res) => {
  try {
    const predictions = await getTidePredictions();
    res.json({ predictions });
  } catch (err) {
    console.error('[api] /api/tides error:', err);
    res.status(502).json({ error: 'Failed to fetch tide predictions' });
  }
});

/** Cached observations for a station + product. */
app.get(bp('/api/observations/:station/:product'), async (req, res) => {
  const { station, product } = req.params;

  // Weather Underground PWS — served from the WU client, not a NOAA cache.
  if (station === WU_STATION) {
    if (product !== 'wind') {
      return res.status(404).json({ error: `Unknown WU product: ${product}` });
    }
    try {
      const data = await getWuWind();
      return res.json({ station, product, count: data.length, data });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }

  const cacher = stationCaches.get(station);

  if (!cacher) {
    return res.status(404).json({ error: `Unknown station: ${station}` });
  }

  try {
    const data = await cacher.getData(product);
    res.json({
      station,
      product,
      count: data.length,
      data,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Full-day tide prediction curve + measured water levels (Providence). */
app.get(bp('/api/tide-curve'), async (_req, res) => {
  try {
    const curve = await getTideCurve();
    const measured = await provCacher.getData('water_level');
    res.json({ curve, measured });
  } catch (err) {
    console.error('[api] /api/tide-curve error:', err);
    res.status(502).json({ error: 'Failed to fetch tide curve' });
  }
});

/** Upcoming events: tides, twilight, moonrise/moonset (next 10). */
app.get(bp('/api/times'), async (_req, res) => {
  try {
    const astro = getAstroEvents();
    const tides = await getTidePredictions();

    // All times are Eastern-local ISO strings ("YYYY-MM-DDTHH:MM")
    const events = [
      ...astro,
      ...tides.map((t) => ({
        time: t.time,   // already local ISO from NOAA
        label: t.type === 'H'
          ? `High tide (${t.height.toFixed(1)} ft)`
          : `Low tide (${t.height.toFixed(1)} ft)`,
      })),
    ];

    // Sort chronologically, filter to future, take first 10
    const now = nowLocal();
    const upcoming = events
      .sort((a, b) => a.time.localeCompare(b.time))
      .filter((e) => e.time > now)
      .slice(0, 10);

    res.json({ events: upcoming });
  } catch (err) {
    console.error('[api] /api/times error:', err);
    res.status(502).json({ error: 'Failed to compute events' });
  }
});

/** Today's nautical dawn/dusk times (for tide graph daylight shading). */
app.get(bp('/api/daylight'), (_req, res) => {
  try {
    res.json(getDaylight());
  } catch (err) {
    console.error('[api] /api/daylight error:', err);
    res.status(502).json({ error: 'Failed to compute daylight times' });
  }
});

/** Current weather conditions — WU (KRICRANS68) preferred, NWS (KPVD) fallback. */
app.get(bp('/api/conditions'), async (_req, res) => {
  try {
    const conditions = await getCurrentConditions();
    res.json(conditions);
  } catch (err) {
    console.error('[api] /api/conditions error:', err);
    res.status(502).json({ error: 'Failed to fetch conditions' });
  }
});

/** 5-day forecast from NWS. */
app.get(bp('/api/forecast'), async (_req, res) => {
  try {
    const forecast = await getForecast();
    res.json({ forecast });
  } catch (err) {
    console.error('[api] /api/forecast error:', err);
    res.status(502).json({ error: 'Failed to fetch forecast' });
  }
});

/** App version from package.json. */
app.get(bp('/api/version'), (_req, res) => {
  res.json({ version: VERSION });
});

// ── PWS wind-direction recalibration ────────────────────────────────────────

/** Current calibration state (public — read-only, no secret needed). */
app.get(bp('/api/calibration'), (_req, res) => {
  res.json(getCalibration());
});

/**
 * Preview a recalibration without applying it (public — read-only). Compares
 * the PWS against NOAA Providence wind over the last hour and returns the
 * proposed offset, confidence, and supporting figures for the operator.
 */
app.get(bp('/api/recalibrate/preview'), async (_req, res) => {
  try {
    const referenceObs = await provVisCacher.getData('wind');
    const preview = await computeRecalibration(referenceObs);
    res.json(preview);
  } catch (err) {
    console.error('[api] /api/recalibrate/preview error:', err);
    res.status(502).json({ error: err.message });
  }
});

/** Apply a calibration (secret-gated). Body is a previewed result. */
app.post(bp('/api/recalibrate'), (req, res) => {
  if (!checkRecalibrateSecret(req, res)) return;
  const offsetDeg = Number(req.body?.offsetDeg);
  if (!Number.isFinite(offsetDeg)) {
    return res.status(400).json({ error: 'offsetDeg must be a finite number.' });
  }
  res.json(applyCalibration(req.body));
});

/** Clear the calibration back to uncalibrated (secret-gated). */
app.post(bp('/api/recalibrate/reset'), (req, res) => {
  if (!checkRecalibrateSecret(req, res)) return;
  res.json(resetCalibration());
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EYC Weather listening on http://localhost:${PORT}`);
});
