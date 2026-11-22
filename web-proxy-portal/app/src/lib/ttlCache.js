'use strict';
/**
 * Minimal in-memory TTL cache.
 *
 * The proxy engine handles hundreds of requests per page load, so it must not
 * hit SQLite for users/sessions/settings on every request. Values are cached
 * for a few seconds; admin changes therefore take effect within that TTL.
 */
class TtlCache {
    constructor(ttlMs, maxEntries = 10000) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.map = new Map();
    }

    get(key, loader) {
        const hit = this.map.get(key);
        const now = Date.now();
        if (hit && hit.expires > now) return hit.value;
        if (!loader) return undefined;
        const value = loader();
        this.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.map.size >= this.maxEntries) {
            // drop the oldest entry (Map keeps insertion order)
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    }

    delete(key) {
        this.map.delete(key);
    }

    clear() {
        this.map.clear();
    }
}

module.exports = TtlCache;
