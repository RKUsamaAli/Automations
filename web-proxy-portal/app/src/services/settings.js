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
    // --- Registration ---
    registration_mode: 'approval', // 'open' = instant access, 'approval' = admin approves, 'closed' = no sign-up page

    // --- User-owned proxies ---
    user_proxies_enabled: true, // users may add their own upstream proxies ("My proxies")
    max_proxies_per_user: 25,

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
    allow_direct: true, // users may browse without a proxy (the server's own connection) - the default choice
    upstream_fallback: 'deny', // 'deny' = refuse when no healthy proxy, 'direct' = use the server's own IP
    upstream_failover: true, // move a session to another proxy of the same pool if its proxy dies

    // --- Search (Browse page address bar) ---
    search_engine: 'google', // google (results via the server's headless browser) | duckduckgo | bing | custom
    search_url_custom: '', // custom results page, {q} = the words, e.g. https://search.example/?q={q}
    search_suggest_url_custom: '', // optional, OpenSearch JSON ["q", ["a", "b"]], {q} = the words
    search_suggestions: true, // suggest search terms while typing (asks the search engine)

    // --- Branding ---
    portal_title: 'Web Portal',
    portal_notice: '', // optional message shown on the landing page
    show_portal_button: true // small "Portal" button on proxied pages (way back on iPhone)
};

const ENUMS = {
    registration_mode: ['open', 'approval', 'closed'],
    upstream_fallback: ['deny', 'direct'],
    search_engine: ['google', 'duckduckgo', 'bing', 'custom']
};

const cache = new TtlCache(3000); // short: several processes share the DB, admin changes must show up quickly

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
    const conn = db.get();
    const upd = conn.prepare(`UPDATE settings SET value = ?, ${db.TOUCH} WHERE key = ?`);
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
            if (ENUMS[key] && !ENUMS[key].includes(value)) {
                throw new Error(`${key} must be one of: ${ENUMS[key].join(', ')}`);
            }
            // update the row if the key exists, otherwise create it (with id + audit columns)
            if (!upd.run(JSON.stringify(value), ...db.touch(), key).changes) db.insert('settings', { key, value: JSON.stringify(value) });
        }
    });
    tx();
    cache.clear();
    return getAll();
}

module.exports = { DEFAULTS, ENUMS, getAll, get, update, clearCache: () => cache.clear() };
