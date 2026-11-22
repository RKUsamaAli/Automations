'use strict';
/**
 * API rate limiting (second layer; nginx limits per IP in front).
 *
 * Per signed-in user (or per IP when signed out), per minute:
 *   API_RATE_LIMIT_RPM       default 600   all /api calls of a user
 *   API_RATE_LIMIT_ANON_RPM  default 120   /api calls without sign-in (per IP)
 *   writes (POST/PUT/PATCH/DELETE) count 3x: they are the expensive ones
 *
 * Every API answer carries the standard headers
 *   RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset (seconds)
 * and a 429 adds Retry-After, so clients can back off politely. Limits are per
 * process; with WEB_INSTANCES=N the effective limit is up to N times higher,
 * which is fine for abuse protection (nginx holds the hard per-IP limit).
 */
const RateLimiter = require('../../lib/rateLimiter');
const events = require('../../services/events');

const limiter = new RateLimiter(60000);
const USER_RPM = () => Number(process.env.API_RATE_LIMIT_RPM) || 600;
const ANON_RPM = () => Number(process.env.API_RATE_LIMIT_ANON_RPM) || 120;
const WRITE_COST = 3;
const warned = new RateLimiter(10 * 60000); // one activity-log entry per key per 10 min

function apiRateLimit(req, res, next) {
    if (!req.originalUrl.startsWith('/api/')) return next();
    const key = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const limit = req.user ? USER_RPM() : ANON_RPM();
    const cost = req.method === 'GET' || req.method === 'HEAD' ? 1 : WRITE_COST;
    let ok = true;
    for (let i = 0; i < cost && ok; i++) ok = limiter.hit(key, limit);
    const st = limiter.state(key, limit);
    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(st.remaining));
    res.set('RateLimit-Reset', String(st.resetSec));
    if (ok) return next();
    res.set('Retry-After', String(st.resetSec));
    if (warned.hit(key, 1)) {
        events.record('api_rate_limited', { userId: req.user ? req.user.id : null, detail: `${limit} requests/min exceeded (${req.method} ${req.path})`, level: 'warn' });
    }
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again in a moment.', code: 'rate_limited', retryAfter: st.resetSec });
}

module.exports = { apiRateLimit };
