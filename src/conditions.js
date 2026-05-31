/**
 * Current-conditions orchestrator.
 *
 * Combines two sources for the "current conditions" card:
 *
 *   - Weather Underground (KRICRANS68) — hyper-local temperature, wind,
 *     humidity, dew point, pressure, precipitation. Preferred when online.
 *   - NWS (KPVD) — sky condition / icon / text description, and a complete
 *     fallback when the WU station is offline.
 *
 * Strategy: favor WU's local numbers, but always take the sky condition and
 * description from NWS (WU provides neither). If WU is offline/stale/disabled,
 * fall back entirely to NWS. If NWS is also unavailable but WU is up, serve
 * WU's numbers with a neutral sky icon.
 */

import { getConditions as getNwsConditions } from './nws.js';
import { getWuConditions } from './wunderground.js';

/**
 * Return merged current conditions, preferring WU and falling back to NWS.
 *
 * @returns {Promise<object>}
 * @throws if neither source is available.
 */
export async function getCurrentConditions() {
  // Fetch both in parallel; both are independently cached. Tolerate either
  // failing — the whole point is graceful degradation.
  const [nwsSettled, wuSettled] = await Promise.allSettled([
    getNwsConditions(),
    getWuConditions(),
  ]);

  const nws = nwsSettled.status === 'fulfilled' ? nwsSettled.value : null;
  const wu = wuSettled.status === 'fulfilled' ? wuSettled.value : null;

  if (nwsSettled.status === 'rejected') {
    console.error('[conditions] NWS fetch failed:', nwsSettled.reason);
  }
  if (wuSettled.status === 'rejected') {
    console.error('[conditions] WU fetch failed:', wuSettled.reason);
  }

  if (!nws && !wu) {
    throw new Error('No conditions available from NWS or WU');
  }

  // WU offline → pure NWS.
  if (!wu) {
    return { ...nws, source: 'nws' };
  }

  // WU online → its local numbers win; borrow the sky condition/description
  // from NWS (WU has none). Provide neutral defaults if NWS is also down.
  return {
    source: 'wunderground',
    stationId: wu.stationId,
    timestamp: wu.timestamp,
    temperature: wu.temperature,
    feelsLike: wu.feelsLike,
    humidity: wu.humidity,
    windSpeed: wu.windSpeed,
    windGust: wu.windGust,
    windDirection: wu.windDirection,
    dewPoint: wu.dewPoint,
    pressure: wu.pressure,
    precipRate: wu.precipRate,
    precipTotal: wu.precipTotal,
    // Sky state comes from NWS only.
    condition: nws?.condition ?? 'skc',
    timeOfDay: nws?.timeOfDay ?? 'day',
    textDescription: nws?.textDescription ?? '',
  };
}
