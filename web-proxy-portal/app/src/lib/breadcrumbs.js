'use strict';
/**
 * Breadcrumbs - the last steps of each user / browsing session, kept ONLY in
 * memory. Nothing is written for successful activity; when an error happens,
 * the trail is attached to the error report so the failure can be replayed.
 *
 *   const trail = new Breadcrumbs({ size: 40 });
 *   trail.add('session:abc', { type: 'request', method: 'GET', url, status: 200, ms: 120 });
 *   trail.get('session:abc')  -> oldest first
 *
 * Memory is bounded: at most `maxKeys` trails, each at most `size` entries,
 * and trails idle for `ttlMs` are dropped.
 */
class Breadcrumbs {
    constructor({ size = 40, maxKeys = 5000, ttlMs = 2 * 3600000 } = {}) {
        this.size = size;
        this.maxKeys = maxKeys;
        this.ttlMs = ttlMs;
        this.trails = new Map(); // key -> { items: [], touched }
        const sweep = setInterval(() => this.sweep(), 10 * 60000);
        sweep.unref();
    }

    add(key, crumb) {
        if (!key) return;
        let t = this.trails.get(key);
        if (!t) {
            if (this.trails.size >= this.maxKeys) this.trails.delete(this.trails.keys().next().value);
            t = { items: [], touched: 0 };
            this.trails.set(key, t);
        }
        t.items.push({ t: Date.now(), ...crumb });
        if (t.items.length > this.size) t.items.shift();
        t.touched = Date.now();
    }

    get(key) {
        const t = this.trails.get(key);
        return t ? t.items.slice() : [];
    }

    sweep() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [k, t] of this.trails) if (t.touched < cutoff) this.trails.delete(k);
    }
}

module.exports = Breadcrumbs;
