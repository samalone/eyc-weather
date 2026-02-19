/**
 * Lazy TTL cache for NOAA observation data.
 *
 * Each StationCache manages one NOAA station and one or more data products
 * (e.g. wind, visibility, water_level).  Data is fetched on demand when a
 * caller requests it and the cache is empty or stale.  No background polling.
 */

import { fetchNoaa } from './noaa.js';

/** Default TTL: 6 minutes (matches NOAA's observation update cadence). */
const DEFAULT_TTL_MS = 6 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a NOAA observation timestamp ("YYYY-MM-DD HH:MM") into an ISO-ish
 * string suitable for `new Date()`.
 */
function normalizeTime(t) {
  return t.replace(' ', 'T');
}

/**
 * Parse the `data` array from a NOAA observation response.
 *
 * Every observation keeps its raw NOAA fields (s, d, g, v, etc.) intact.
 * We just normalize the timestamp into `time` (ISO string) and drop the
 * quality-flag field `f` since we don't use it.
 */
function parseObservations(data) {
  return data.map(({ t, f, ...fields }) => ({
    time: normalizeTime(t),
    ...fields,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

export class StationCache {
  /** @type {string} */
  #stationId;

  /** @type {string[]} */
  #products;

  /** @type {Map<string, object[]>} product → sorted observations */
  #data = new Map();

  /** @type {Map<string, number>} product → Date.now() when last fetched */
  #fetchedAt = new Map();

  /** @type {number} cache TTL in ms */
  #ttlMs;

  /** @type {string} NOAA `range` param (hours of history to fetch) */
  #windowHours;

  /** @type {Record<string, Record<string, string>>} extra params per product */
  #productParams;

  /**
   * @param {string}   stationId       NOAA station ID
   * @param {string[]} products        Product names (e.g. ['wind', 'visibility'])
   * @param {object}   [options]
   * @param {string}   [options.windowHours]  Hours of history to fetch (default '1')
   * @param {number}   [options.ttlMs]        How long data is fresh (default 60 s)
   * @param {Record<string, Record<string, string>>} [options.productParams]
   *   Per-product extra query params, e.g. { water_level: { datum: 'MLLW' } }
   */
  constructor(stationId, products, options = {}) {
    this.#stationId = stationId;
    this.#products = products;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#windowHours = options.windowHours ?? '1';
    this.#productParams = options.productParams ?? {};

    for (const p of products) {
      this.#data.set(p, []);
      this.#fetchedAt.set(p, 0);
    }
  }

  // ── Data access ─────────────────────────────────────────────────────────

  /**
   * Return observations for a product, sorted by time ascending.
   * Fetches from NOAA if the cache is empty or stale.
   *
   * @param {string} product
   * @returns {Promise<object[]>}  Shallow copy of the observations array.
   */
  async getData(product) {
    if (!this.#data.has(product)) {
      throw new Error(`Unknown product "${product}" for station ${this.#stationId}`);
    }

    const now = Date.now();
    const lastFetch = this.#fetchedAt.get(product);

    if (!lastFetch || (now - lastFetch) >= this.#ttlMs) {
      await this.#fetchProduct(product);
    }

    return [...this.#data.get(product)];
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Fetch the full observation window for a product from NOAA and replace
   * the cached data.
   */
  async #fetchProduct(product) {
    const extra = this.#productParams[product] ?? {};

    console.log(`[cache] Fetching ${this.#stationId}/${product} (range=${this.#windowHours}h)`);

    const json = await fetchNoaa({
      station: this.#stationId,
      product,
      range: this.#windowHours,
      ...extra,
    });

    if (!json?.data?.length) {
      console.warn(`[cache] No data returned for ${this.#stationId}/${product}`);
      // Still mark as fetched so we don't hammer NOAA on repeated empty responses
      this.#fetchedAt.set(product, Date.now());
      return;
    }

    const obs = parseObservations(json.data);
    this.#data.set(product, obs);
    this.#fetchedAt.set(product, Date.now());

    console.log(`[cache] Cached ${this.#stationId}/${product}: ${obs.length} observations`);
  }
}
