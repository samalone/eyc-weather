# EYC Weather App

One-page weather dashboard for Edgewood Yacht Club (EYC) in Cranston, RI. Merges data from NOAA and a private Weather Underground station into a single view optimized for sailors and boaters.

## Tech Stack

- **Runtime:** Node.js
- **Target browsers:** Safari 26+ on macOS/iOS (modern CSS/JS, no polyfills)
- **Deployment:** Container in Kubernetes
- **Storage:** In-memory caching only, no database or persistent storage

## Data Sources

### NOAA CO-OPS Tides & Currents (no API key required)

Base URL: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`

**Station 8453662 — Providence Visibility** (41.7857 N, -71.3831 W)
- Visibility (`product=visibility`) — nautical miles
- Air temperature (`product=air_temperature`)
- Wind speed, direction, gusts (`product=wind`)
- Barometric pressure (`product=air_pressure`)
- Humidity (`product=humidity`)

**Station 8454000 — Providence** (41.8072 N, -71.4007 W)
- Water level / tides (`product=water_level`, requires `datum` param, e.g. `MLLW`)
- Air temperature (`product=air_temperature`)

**Station 8453767 — Pawtuxet Cove, Providence River** (41.7617 N, -71.3883 W)
- Tide predictions only (`product=predictions`, requires `datum` param)
- Closer to EYC than station 8454000; use this for tide predictions

Common query params: `date=latest`, `units=english`, `time_zone=lst_ldt`, `format=json`

### Weather Underground PWS API (API key required)

Base URL: `https://api.weather.com/v2/pws/observations/current`

**Station KRICRANS68** — "Edgewood Yacht Club" private station in Cranston, RI (41.78 N, -71.39 W), operated by an EYC member

Query params: `stationId=KRICRANS68`, `format=json`, `units=e`, `numericPrecision=decimal`, `apiKey=<key>`

Rate limits: 1,500 calls/day, 30 calls/min.

Provides: temperature, humidity, dew point, wind (speed/dir/gust), pressure, precipitation rate & total, solar radiation, UV index. Note: the KRICRANS68 unit (a myAcuRite) reports `solarRadiation` and `uv` as `null` — it has no solar/UV sensor.

The API key must be obtained from a Weather Underground account that owns a contributing PWS. Store it in the `WUNDERGROUND_API_KEY` environment variable (station ID in `WUNDERGROUND_STATION_ID`, default `KRICRANS68`).

> **Status:** Integrated. `src/wunderground.js` fetches/caches the current observation; `src/conditions.js` orchestrates the `/api/conditions` card — it **favors WU** for local temp/wind/humidity/dew point/pressure/precip, borrows the sky condition & description from NWS (WU has none), and **falls back entirely to NWS** when the WU station is offline, stale (>30 min), or the key is missing. WU wind on the compass (`/api/observations`) is still future work.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WUNDERGROUND_API_KEY` | No (deferred) | Weather Underground API key (32 chars) |
| `PORT` | No | HTTP listen port (default: 3000) |

## Architecture Notes

- Single Express server serves both the API and the static frontend
- All routes are mounted under `/eyc-weather` (hardcoded `BASE_PATH`)
- Frontend uses relative URLs (no leading `/`) so they resolve correctly under the prefix
- Backend fetches from NOAA (and eventually WU) on a schedule, caches in memory
- Frontend is a single HTML page with inline or bundled CSS/JS
- NOAA data needs no API key; WU data requires the env var above
- Cache TTL ~5 min (NOAA updates roughly every 6 minutes)
- Mobile-friendly, responsive card-based layout
- Dark mode support via `prefers-color-scheme` and/or manual toggle

## Deployment

- **Container:** Docker image `llamagraphics/eyc-weather` on Docker Hub
- **Orchestration:** Kubernetes via Kustomize (`k8s/prod/`)
- **Cluster:** `kubectl --context pc` (Linode)
- **Ingress:** Shares hosts with `course-server-ingress` at `/eyc-weather` path prefix
- **Versioning:** Semver tag in `k8s/prod/kustomization.yaml`, managed by `scripts/release.sh`
- **VS Code tasks:** Release: Patch/Minor/Major (bump, build, deploy, commit, tag, push)

## Project Conventions

- Use ES modules (`"type": "module"` in package.json)
- Use `const`/`let`, never `var`
- Prefer `fetch` (Node 18+ built-in) over axios/node-fetch
- Keep dependencies minimal
- No TypeScript — plain JS for simplicity
- Semantic HTML, modern CSS (grid, custom properties, container queries OK)
- Use `oklch` color space for all colors
- No frontend build step — serve static files directly
