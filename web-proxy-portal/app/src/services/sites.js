'use strict';
/**
 * Target sites configured by the admin. Nothing is hard-coded: each site has
 * a start URL, the domain patterns it uses, and optionally its own proxy pool.
 * Sites also feed the domain allowlist (when enabled).
 */
const db = require('../db');
const TtlCache = require('../lib/ttlCache');
const settings = require('./settings');
const { parsePatterns, isValidPattern, matchesAny, hostOf } = require('../lib/domainMatch');

const cache = new TtlCache(10000);

function list() {
    return db.get().prepare('SELECT * FROM sites ORDER BY sort_order, name').all();
}

function listEnabled() {
    return cache.get('enabled', () => db.get().prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY sort_order, name').all());
}

function validate({ name, startUrl, domains }) {
    if (!name || String(name).length > 80) throw new Error('Site name is required (max 80 chars)');
    const host = hostOf(startUrl);
    if (!host) throw new Error('Start URL must be a valid http(s) URL');
    const patterns = parsePatterns(domains);
    if (!patterns.length) throw new Error('At least one domain pattern is required');
    const bad = patterns.filter((p) => !isValidPattern(p));
    if (bad.length) throw new Error(`Invalid domain pattern(s): ${bad.join(', ')}`);
    if (!matchesAny(host, patterns)) throw new Error(`Start URL host "${host}" is not covered by the domain patterns`);
    return patterns.join(',');
}

function save({ id, name, startUrl, domains, poolId = null, enabled = true, showOnLanding = true, sortOrder = 0 }) {
    const normalized = validate({ name, startUrl, domains });
    const conn = db.get();
    let siteId = id;
    if (id) {
        conn.prepare(
            'UPDATE sites SET name = ?, start_url = ?, domains = ?, pool_id = ?, enabled = ?, show_on_landing = ?, sort_order = ? WHERE id = ?'
        ).run(name, startUrl, normalized, poolId || null, enabled ? 1 : 0, showOnLanding ? 1 : 0, Number(sortOrder) || 0, id);
    } else {
        siteId = conn
            .prepare(
                'INSERT INTO sites (name, start_url, domains, pool_id, enabled, show_on_landing, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )
            .run(name, startUrl, normalized, poolId || null, enabled ? 1 : 0, showOnLanding ? 1 : 0, Number(sortOrder) || 0, Date.now())
            .lastInsertRowid;
    }
    cache.clear();
    return conn.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
}

function remove(id) {
    db.get().prepare('DELETE FROM sites WHERE id = ?').run(id);
    cache.clear();
}

/**
 * Allowlist check shared by the portal (start URL) and the proxy engine (navigations).
 * @returns {boolean} true when the host may be visited
 */
function isHostAllowed(host) {
    const s = settings.getAll();
    if (!s.allowlist_enabled) return true;
    if (!host) return false;
    if (matchesAny(host, s.allowlist_extra)) return true;
    return listEnabled().some((site) => matchesAny(host, site.domains));
}

module.exports = { list, listEnabled, save, remove, isHostAllowed, clearCache: () => cache.clear() };
