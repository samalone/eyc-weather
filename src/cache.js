/**
 * Rolling time-series cache for NOAA observation data.
 *
 * Each StationCache manages one NOAA station and one or more data products
 * (e.g. wind, visibility, water_level).  On init it pre-fills the past
 * hour of data; once started it incrementally appends new observations and
 * trims anything older than the retention window.
 */

import { fetchNoaa } from './noaa.js';

/** Default retention window: 1 hour. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Default refresh interval: 60 seconds. */
const DEFAULT_REFRESH_MS = 60 * 1000;

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

  /** @type {number} retention window in ms */
  #windowMs;

  /** @type {number} refresh interval in ms */
  #refreshMs;

  /** @type {ReturnType<typeof setInterval> | null} */
  #intervalId = null;

  /** @type {Record<string, string>} extra params per product (e.g. datum) */
  #productParams;

  /**
   * @param {string}   stationId       NOAA station ID
   * @param {string[]} products        Product names (e.g. ['wind', 'visibility'])
   * @param {object}   [options]
   * @param {number}   [options.windowMs]   Retention window (default 1 hr)
   * @param {number}   [options.refreshMs]  Refresh interval (default 60 s)
   * @param {Record<string, Record<string, string>>} [options.productParams]
   *   Per-product extra query params, e.g. { water_level: { datum: 'MLLW' } }
   */
  constructor(stationId, products, options = {}) {
    this.#stationId = stationId;
    this.#products = products;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    this.#productParams = options.productParams ?? {};

    for (const p of products) {
      this.#data.set(p, []);
    }
  }

  /** The NOAA station ID this cache covers. */
  get stationId() {
    return this.#stationId;
  }

  /** The product names this cache covers. */
  get products() {
    return [...this.#products];
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Pre-fill the cache with the past hour of observations for every product.
   * Call this once before `start()`.
   */
  async init() {
    console.log(`[cache] Initializing station ${this.#stationId}: ${this.#products.join(', ')}`);

    const results = await Promise.allSettled(
      this.#products.map((product) => this.#fillProduct(product)),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.error(
          `[cache] Failed to init ${this.#stationId}/${this.#products[i]}:`,
          r.reason?.message ?? r.reason,
        );
      }
    }
  }

  /**
   * Start the periodic refresh loop.  Calls `refresh()` every `refreshMs`.
   */
  start() {
    if (this.#intervalId) return;
    this.#intervalId = setInterval(() => this.refresh(), this.#refreshMs);
    console.log(
      `[cache] Station ${this.#stationId} refresh started (every ${this.#refreshMs / 1000}s)`,
    );
  }

  /**
   * Stop the periodic refresh loop.
   */
  stop() {
    if (this.#intervalId) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  }

  // ── Data access ─────────────────────────────────────────────────────────

  /**
   * Return the cached observations for a product, sorted by time ascending.
   *
   * @param {string} product
   * @returns {object[]}  Shallow copy of the observations array.
   */
  getData(product) {
    const arr = this.#data.get(product);
    if (!arr) {
      throw new Error(`Unknown product "${product}" for station ${this.#stationId}`);
    }
    return [...arr];
  }

  /**
   * Return the most recent observation for a product, or null if empty.
   *
   * @param {string} product
   * @returns {object | null}
   */
  getLatest(product) {
    const arr = this.#data.get(product);
    if (!arr?.length) return null;
    return arr[arr.length - 1];
  }

  // ── Internal: fill & refresh ────────────────────────────────────────────

  /**
   * Fetch the past hour of a product and store it.
   */
  async #fillProduct(product) {
    const extra = this.#productParams[product] ?? {};
    const json = await fetchNoaa({
      station: this.#stationId,
      product,
      range: '1',
      ...extra,
    });

    if (!json?.data?.length) {
      console.warn(`[cache] No data returned for ${this.#stationId}/${product}`);
      return;
    }

    const obs = parseObservations(json.data);
    this.#data.set(product, obs);
    console.log(
      `[cache] Filled ${this.#stationId}/${product}: ${obs.length} observations`,
    );
  }

  /**
   * Fetch the latest observation for every product, append any new ones,
   * and trim entries older than the retention window.
   */
  async refresh() {
    const results = await Promise.allSettled(
      this.#products.map((product) => this.#refreshProduct(product)),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.warn(
          `[cache] Refresh failed for ${this.#stationId}/${this.#products[i]}:`,
          r.reason?.message ?? r.reason,
        );
      }
    }
  }

  /**
   * Fetch `date=latest` for a single product, append if new, then trim.
   */
  async #refreshProduct(product) {
    const extra = this.#productParams[product] ?? {};
    const json = await fetchNoaa({
      station: this.#stationId,
      product,
      date: 'latest',
      ...extra,
    });

    if (!json?.data?.length) return;

    const [newest] = parseObservations(json.data);
    const arr = this.#data.get(product);

    // Only append if it's genuinely newer than the last cached point
    const lastTime = arr.length ? arr[arr.length - 1].time : null;
    if (newest.time !== lastTime) {
      arr.push(newest);
    }

    // Trim observations older than the retention window
    this.#trim(product);
  }

  /**
   * Remove observations whose timestamp falls outside the retention window.
   */
  #trim(product) {
    const arr = this.#data.get(product);
    const cutoff = new Date(Date.now() - this.#windowMs).toISOString().slice(0, 16);

    // Observations are sorted chronologically; find the first index to keep
    let firstKeep = 0;
    while (firstKeep < arr.length && arr[firstKeep].time < cutoff) {
      firstKeep++;
    }

    if (firstKeep > 0) {
      arr.splice(0, firstKeep);
    }
  }
}
