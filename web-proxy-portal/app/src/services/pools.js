'use strict';
/**
 * Upstream proxy pools and proxies.
 *
 * Selection rules (see resolvePoolId):
 *   1. the user's own pool override (users.pool_id)
 *   2. the pool of the configured site whose domains match the start URL
 *   3. the pool marked "default"
 *
 * Within a pool we pick the healthy proxy with the FEWEST active sessions,
 * so load is spread evenly. The chosen proxy is stored on the session and
 * kept for the whole session ("sticky") - see src/proxy/upstream.js.
 */
const db = require('../db');
const TtlCache = require('../lib/ttlCache');
const { parseProxyList } = require('../lib/proxyString');
const { matchesAny, hostOf } = require('../lib/domainMatch');

const POOL_TYPES = ['residential', 'isp', 'datacenter', 'mobile', 'other'];
const cache = new TtlCache(10000);

// ---------------------------------------------------------------- pools ----
function listPools() {
    return db
        .get()
        .prepare(
            `SELECT p.*,
                (SELECT COUNT(*) FROM proxies x WHERE x.pool_id = p.id) AS proxy_count,
                (SELECT COUNT(*) FROM proxies x WHERE x.pool_id = p.id AND x.enabled = 1 AND x.status IN ('healthy','unknown')) AS usable_count,
                (SELECT COUNT(*) FROM sessions s WHERE s.pool_id = p.id AND s.ended_at IS NULL) AS active_sessions
             FROM proxy_pools p ORDER BY p.is_default DESC, p.name`
        )
        .all();
}

function getPool(id) {
    return db.get().prepare('SELECT * FROM proxy_pools WHERE id = ?').get(id) || null;
}

function getPoolByName(name) {
    return db.get().prepare('SELECT * FROM proxy_pools WHERE name = ?').get(name) || null;
}

function savePool({ id, name, country = null, type = 'datacenter', isDefault = false, description = null }) {
    if (!name || String(name).length > 80) throw new Error('Pool name is required (max 80 chars)');
    if (!POOL_TYPES.includes(type)) throw new Error(`Pool type must be one of: ${POOL_TYPES.join(', ')}`);
    const conn = db.get();
    const tx = conn.transaction(() => {
        if (isDefault) conn.prepare('UPDATE proxy_pools SET is_default = 0').run();
        if (id) {
            conn.prepare('UPDATE proxy_pools SET name = ?, country = ?, type = ?, is_default = ?, description = ? WHERE id = ?').run(
                name,
                country || null,
                type,
                isDefault ? 1 : 0,
                description || null,
                id
            );
            return id;
        }
        // The very first pool automatically becomes the default.
        const first = conn.prepare('SELECT COUNT(*) AS n FROM proxy_pools').get().n === 0;
        return conn
            .prepare('INSERT INTO proxy_pools (name, country, type, is_default, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(name, country || null, type, isDefault || first ? 1 : 0, description || null, Date.now()).lastInsertRowid;
    });
    try {
        const poolId = tx();
        cache.clear();
        return getPool(poolId);
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new Error('A pool with that name already exists');
        throw e;
    }
}

function deletePool(id) {
    db.get().prepare('DELETE FROM proxy_pools WHERE id = ?').run(id);
    cache.clear();
}

// -------------------------------------------------------------- proxies ----
const PROXY_PUBLIC = `id, pool_id, protocol, host, port, username, (password IS NOT NULL) AS has_password,
    enabled, status, latency_ms, fail_count, last_checked_at, last_error, created_at`;

function listProxies(poolId) {
    return db
        .get()
        .prepare(
            `SELECT ${PROXY_PUBLIC},
                (SELECT COUNT(*) FROM sessions s WHERE s.proxy_id = proxies.id AND s.ended_at IS NULL) AS active_sessions
             FROM proxies WHERE pool_id = ? ORDER BY id`
        )
        .all(poolId);
}

/** Full rows INCLUDING credentials - only for the proxy engine / health checker. */
function allProxiesWithSecrets() {
    return db.get().prepare('SELECT * FROM proxies').all();
}

function getProxyWithSecrets(id) {
    return cache.get('proxy:' + id, () => db.get().prepare('SELECT * FROM proxies WHERE id = ?').get(id) || null);
}

/**
 * Imports proxies from pasted text into a pool. Duplicates are skipped.
 * @returns {{ added: number, skipped: number, errors: string[] }}
 */
function importProxies(poolId, text, defaultProtocol = 'http') {
    if (!getPool(poolId)) throw new Error('Pool not found');
    const { proxies, errors } = parseProxyList(text, defaultProtocol);
    const stmt = db
        .get()
        .prepare(
            `INSERT OR IGNORE INTO proxies (pool_id, protocol, host, port, username, password, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
    let added = 0;
    const tx = db.get().transaction(() => {
        for (const p of proxies) {
            added += stmt.run(poolId, p.protocol, p.host, p.port, p.username, p.password, Date.now()).changes;
        }
    });
    tx();
    cache.clear();
    return { added, skipped: proxies.length - added, errors };
}

function setProxyEnabled(id, enabled) {
    db.get().prepare('UPDATE proxies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    cache.clear();
}

function deleteProxy(id) {
    db.get().prepare('DELETE FROM proxies WHERE id = ?').run(id);
    cache.clear();
}

function deleteDeadProxies(poolId) {
    const n = db.get().prepare("DELETE FROM proxies WHERE pool_id = ? AND status = 'dead'").run(poolId).changes;
    cache.clear();
    return n;
}

/** Called by the health checker after each probe. */
function recordHealth(id, { ok, latencyMs, error, slowMs, failuresBeforeDead }) {
    const conn = db.get();
    const row = conn.prepare('SELECT fail_count FROM proxies WHERE id = ?').get(id);
    if (!row) return null;
    let status;
    let failCount;
    if (ok) {
        failCount = 0;
        status = latencyMs > slowMs ? 'slow' : 'healthy';
    } else {
        failCount = row.fail_count + 1;
        status = failCount >= failuresBeforeDead ? 'dead' : 'unknown';
    }
    conn.prepare('UPDATE proxies SET status = ?, latency_ms = ?, fail_count = ?, last_checked_at = ?, last_error = ? WHERE id = ?').run(
        status,
        ok ? latencyMs : null,
        failCount,
        Date.now(),
        ok ? null : String(error || 'failed').slice(0, 300),
        id
    );
    cache.delete('proxy:' + id);
    return status;
}

// ------------------------------------------------------------ selection ----
function defaultPoolId() {
    return cache.get('defaultPool', () => {
        const row = db.get().prepare('SELECT id FROM proxy_pools WHERE is_default = 1 LIMIT 1').get();
        return row ? row.id : null;
    });
}

/**
 * Decides which pool a new session uses.
 * @param {object} user  row from users service
 * @param {string} startUrl
 * @param {object[]} sites enabled sites
 */
function resolvePoolId(user, startUrl, sites) {
    if (user && user.pool_id) return user.pool_id;
    const host = hostOf(startUrl);
    if (host) {
        const site = sites.find((s) => s.pool_id && matchesAny(host, s.domains));
        if (site) return site.pool_id;
    }
    return defaultPoolId();
}

/**
 * Picks the least-loaded usable proxy in a pool.
 * "healthy" beats "unknown" (not yet checked); "slow" and "dead" are skipped,
 * but slow proxies are used as a last resort.
 * @returns proxy row with credentials, or null
 */
function pickProxy(poolId, excludeIds = []) {
    if (!poolId) return null;
    const rows = db
        .get()
        .prepare(
            `SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.proxy_id = p.id AND s.ended_at IS NULL) AS load
             FROM proxies p WHERE p.pool_id = ? AND p.enabled = 1 AND p.status != 'dead'`
        )
        .all(poolId)
        .filter((p) => !excludeIds.includes(p.id));
    if (!rows.length) return null;
    const rank = { healthy: 0, unknown: 1, slow: 2 };
    rows.sort((a, b) => rank[a.status] - rank[b.status] || a.load - b.load || Math.random() - 0.5);
    return rows[0];
}

function isUsable(proxy) {
    return !!proxy && proxy.enabled === 1 && proxy.status !== 'dead';
}

module.exports = {
    POOL_TYPES,
    listPools,
    getPool,
    getPoolByName,
    savePool,
    deletePool,
    listProxies,
    allProxiesWithSecrets,
    getProxyWithSecrets,
    importProxies,
    setProxyEnabled,
    deleteProxy,
    deleteDeadProxies,
    recordHealth,
    defaultPoolId,
    resolvePoolId,
    pickProxy,
    isUsable,
    clearCache: () => cache.clear()
};
