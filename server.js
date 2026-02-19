import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTidePredictions } from './src/noaa.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

// ── Static files ────────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

// ── API routes ──────────────────────────────────────────────────────────────

app.get('/api/tides', async (_req, res) => {
  try {
    const predictions = await getTidePredictions();
    res.json({ predictions });
  } catch (err) {
    console.error('[api] /api/tides error:', err);
    res.status(502).json({ error: 'Failed to fetch tide predictions' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EYC Weather listening on http://localhost:${PORT}`);
});
