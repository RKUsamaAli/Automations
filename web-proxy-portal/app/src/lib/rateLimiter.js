'use strict';
/**
 * Fixed-window rate limiter kept in memory.
 *
 *   const limiter = new RateLimiter(60_000);
 *   if (!limiter.hit('user:5', 600)) -> over the limit
 *
 * Memory is bounded: expired windows are swept every minute.
 * (nginx adds a second, per-IP layer in front - see deploy/templates/nginx-site.conf.tpl)
 */
class RateLimiter {
    constructor(windowMs = 60000) {
        this.windowMs = windowMs;
        this.windows = new Map();
        this.sweeper = setInterval(() => this.sweep(), 60000);
        this.sweeper.unref();
    }

    /** Counts one hit. @returns {boolean} true when still within `limit` */
    hit(key, limit) {
        if (!limit || limit <= 0) return true; // 0 / null = unlimited
        const now = Date.now();
        let w = this.windows.get(key);
        if (!w || w.reset <= now) {
            w = { count: 0, reset: now + this.windowMs };
            this.windows.set(key, w);
        }
        w.count += 1;
        return w.count <= limit;
    }

    /** { limit, remaining, resetSec } for RateLimit-* response headers. */
    state(key, limit) {
        const w = this.windows.get(key);
        const now = Date.now();
        if (!w || w.reset <= now) return { limit, remaining: limit, resetSec: Math.ceil(this.windowMs / 1000) };
        return { limit, remaining: Math.max(0, limit - w.count), resetSec: Math.max(1, Math.ceil((w.reset - now) / 1000)) };
    }

    /** Seconds until the window for `key` resets. */
    retryAfter(key) {
        const w = this.windows.get(key);
        return w ? Math.max(1, Math.ceil((w.reset - Date.now()) / 1000)) : 1;
    }

    reset(key) {
        this.windows.delete(key);
    }

    sweep() {
        const now = Date.now();
        for (const [k, w] of this.windows) if (w.reset <= now) this.windows.delete(k);
    }
}

module.exports = RateLimiter;
