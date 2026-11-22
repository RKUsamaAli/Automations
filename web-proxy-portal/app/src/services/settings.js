'use strict';
/**
 * Runtime settings editable from the admin panel (stored in the `settings` table).
 *
 * Every setting has a default here, so a fresh database works immediately.
 * Values are JSON-encoded in the DB.
 */
const db = require('../db');
const TtlCache = require('../lib/ttlCache');

const DEFAULTS = {
    // --- Access control ---
    allowlist_enabled: false, // only allow domains of configured sites + allowlist_extra
    allowlist_extra: '', // extra patterns, comma/newline separated, e.g. "*.example.com"
    allowlist_strict: false, // false = check page navigations only, true = every sub-request too
    restrict_session_to_ip: false, // true breaks mobile users that switch Wi-Fi <-> 4G

    // --- Rate limiting (per user) ---
    rate_limit_rpm: 1200, // proxied requests per minute (a single page can load 100+ resources)
    bandwidth_limit_mb_day: 0, // 0 = unlimited
    max_sessions_per_user: 5, // concurrently active browsing sessions

    // --- Upstream proxies ---
    upstream_fallback: 'deny', // 'deny' = refuse when no healthy proxy, 'direct' = use the server's own IP
    upstream_failover: true, // move a session to another proxy of the same pool if its proxy dies

    // --- Branding ---
    portal_title: 'Web Portal',
    portal_notice: '' // optional message shown on the landing page
};

const cache = new TtlCache(10000);

function getAll() {
    return cache.get('all', () => {
        const rows = db.get().prepare('SELECT key, value FROM settings').all();
        const values = { ...DEFAULTS };
        for (const row of rows) {
            if (!(row.key in DEFAULTS)) continue;
            try {
                values[row.key] = JSON.parse(row.value);
            } catch (_) {
                /* ignore corrupt value, keep default */
            }
        }
        return values;
    });
}

function get(key) {
    return getAll()[key];
}

/** Updates known keys only; coerces each value to the default's type. */
function update(patch) {
    const stmt = db
        .get()
        .prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
        );
    const now = Date.now();
    const tx = db.get().transaction(() => {
        for (const [key, raw] of Object.entries(patch || {})) {
            if (!(key in DEFAULTS)) continue;
            const def = DEFAULTS[key];
            let value = raw;
            if (typeof def === 'boolean') value = raw === true || raw === 'true' || raw === 1 || raw === '1';
            else if (typeof def === 'number') {
                value = Number(raw);
                if (!Number.isFinite(value) || value < 0) throw new Error(`Setting ${key} must be a non-negative number`);
            } else value = String(raw ?? '');
            if (key === 'upstream_fallback' && !['deny', 'direct'].includes(value)) {
                throw new Error('upstream_fallback must be "deny" or "direct"');
            }
            stmt.run(key, JSON.stringify(value), now);
        }
    });
    tx();
    cache.clear();
    return getAll();
}

module.exports = { DEFAULTS, getAll, get, update, clearCache: () => cache.clear() };
