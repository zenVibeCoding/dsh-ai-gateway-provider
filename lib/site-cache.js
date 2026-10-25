/**
 * Disk cache for what a gateway site told us about itself: family, version, public
 * info, its own icon and title. Identification costs two requests per gateway and its
 * answer changes rarely, so it outlives a process.
 *
 * Only public facts are stored — no token, no header, nothing tied to a user.
 */
import { readCache, writeCache } from './util.js';

const FILE = 'site-facts.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 40;

export class SiteFactsCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, limit = DEFAULT_LIMIT, logger } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.logger = logger;
    const saved = readCache(FILE);
    this.entries = new Map();
    for (const [origin, entry] of Object.entries(saved?.entries ?? {})) {
      if (entry && typeof entry.at === 'number' && entry.value && typeof entry.value === 'object') this.entries.set(origin, entry);
    }
  }

  /** Fresh entry for one origin, or undefined. Expired entries are dropped on read. */
  get(origin) {
    const hit = this.entries.get(origin);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.entries.delete(origin); return undefined; }
    return hit.value;
  }

  set(origin, value) {
    if (!value || typeof value !== 'object') return;
    this.entries.delete(origin);
    this.entries.set(origin, { at: Date.now(), value });
    // Oldest first: Map preserves insertion order, and set() re-inserts.
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    try { writeCache(FILE, { version: 1, entries: Object.fromEntries(this.entries) }); }
    catch (error) { this.logger?.warn?.(`ai-gateway: site facts cache write failed: ${error.message}`); }
  }

  clear() { this.entries.clear(); }
}
