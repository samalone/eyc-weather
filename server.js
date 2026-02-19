import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  getTidePredictions,
  STATION_PROVIDENCE_VIS,
  STATION_PROVIDENCE,
} from './src/noaa.js';
import { StationCache } from './src/cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

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

/** Providence — water level observations */
const provCacher = new StationCache(STATION_PROVIDENCE, ['water_level'], {
  productParams: { water_level: { datum: 'MLLW' } },
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

// ── Static files ────────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

// ── API routes ──────────────────────────────────────────────────────────────

/** Tide predictions (hi/lo for Pawtuxet Cove). */
app.get('/api/tides', async (_req, res) => {
  try {
    const predictions = await getTidePredictions();
    res.json({ predictions });
  } catch (err) {
    console.error('[api] /api/tides error:', err);
    res.status(502).json({ error: 'Failed to fetch tide predictions' });
  }
});

/** Cached observations for a station + product. */
app.get('/api/observations/:station/:product', (req, res) => {
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

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EYC Weather listening on http://localhost:${PORT}`);
});
