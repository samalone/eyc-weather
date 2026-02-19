import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  getTidePredictions,
  getTideCurve,
  STATION_PROVIDENCE_VIS,
  STATION_PROVIDENCE,
} from './src/noaa.js';
import { StationCache } from './src/cache.js';
import { getConditions, getForecast } from './src/nws.js';
import { getAstroEvents, getDaylight, nowLocal } from './src/astro.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE_PATH = '/eyc-weather';

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// ── Observation caches ──────────────────────────────────────────────────────

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
  windowMs: 25 * 60 * 60 * 1000,
  fillRange: '25',
});

stationCaches.set(STATION_PROVIDENCE_VIS, provVisCacher);
stationCaches.set(STATION_PROVIDENCE, provCacher);

// ── Initialize caches before starting the server ────────────────────────────

console.log('[server] Initializing observation caches…');
await Promise.all([provVisCacher.init(), provCacher.init()]);
provVisCacher.start();
provCacher.start();
console.log('[server] Observation caches ready.');

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();

/** Prefix a route path with the BASE_PATH. */
const bp = (path) => `${BASE_PATH}${path}`;

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
app.get(bp('/api/observations/:station/:product'), (req, res) => {
  const { station, product } = req.params;
  const cacher = stationCaches.get(station);

  if (!cacher) {
    return res.status(404).json({ error: `Unknown station: ${station}` });
  }

  try {
    const data = cacher.getData(product);
    res.json({
      station,
      product,
      count: data.length,
      data,
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** Full-day tide prediction curve + measured water levels (Providence). */
app.get(bp('/api/tide-curve'), async (_req, res) => {
  try {
    const curve = await getTideCurve();
    const measured = provCacher.getData('water_level');
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

/** Current weather conditions from NWS (KPVD). */
app.get(bp('/api/conditions'), async (_req, res) => {
  try {
    const conditions = await getConditions();
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

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EYC Weather listening on http://localhost:${PORT}`);
});
