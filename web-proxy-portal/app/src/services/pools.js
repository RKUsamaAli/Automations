'use strict';
/**
 * Upstream proxy pools and proxies.
 *
 * Two kinds of pools:
 *   - ADMIN pools (owner_user_id NULL): visibility 'all' = every user may use it,
 *     'assigned' = only users listed in pool_access ("allow to users").
 *   - PERSONAL pools (owner_user_id = user): proxies a user added under
 *     "My proxies". Only that user can use them.
 *
 * Selection rules for a new session (see resolvePoolId):
 *   1. the pool the user picked on the landing page (if they may use it)
 *   2. the user's pool override set by an admin (users.pool_id)
 *   3. the pool of the configured site whose domains match the start URL
 *   4. the pool marked "default"
 *   5. the user's personal pool
 *
 * Within a pool we pick the healthy proxy with the FEWEST active sessions,
 * so load is spread evenly. The chosen proxy is stored on the session and
 * kept for the whole session ("sticky") - see src/proxy/upstream.js.
 */
const db = require('../db');
const paging = require('../lib/paging');
const { isId } = require('../lib/ids');
const TtlCache = require('../lib/ttlCache');
const { parseProxyList } = require('../lib/proxyString');
const { assertPublicHost } = require('../lib/netGuard');
const { matchesAny, hostOf } = require('../lib/domainMatch');

const POOL_TYPES = ['residential', 'isp', 'datacenter', 'mobile', 'other'];
const cache = new TtlCache(3000); // short: several processes share the DB, admin changes must show up quickly

// ---------------------------------------------------------------- pools ----
const POOL_STATS = `
    (SELECT COUNT(*) FROM proxies x WHERE x.pool_id = p.id) AS proxy_count,
    (SELECT COUNT(*) FROM proxies x WHERE x.pool_id = p.id AND x.enabled = 1 AND x.status IN ('healthy','unknown','slow')) AS usable_count,
    (SELECT COUNT(*) FROM sessions s WHERE s.pool_id = p.id AND s.ended_at IS NULL) AS active_sessions`;

/** All pools (admin view), with owner and number of users it is assigned to. */
function listPools() {
    return db
        .get()
        .prepare(
            `SELECT p.*, ${POOL_STATS}, u.username AS owner_username,
                (SELECT COUNT(*) FROM pool_access a WHERE a.pool_id = p.id) AS assigned_count
             FROM proxy_pools p LEFT JOIN users u ON u.id = p.owner_user_id
             ORDER BY (p.owner_user_id IS NOT NULL), p.is_default DESC, p.name`
        )
        .all();
}

/** Pools a user may browse through: shared admin pools, pools assigned to them, their own. */
function listAccessiblePools(user) {
    return db
        .get()
        .prepare(
            `SELECT p.id, p.name, p.country, p.type, p.is_default, p.owner_user_id, ${POOL_STATS}
             FROM proxy_pools p
             WHERE (p.owner_user_id IS NULL AND (p.visibility = 'all' OR EXISTS (SELECT 1 FROM pool_access a WHERE a.pool_id = p.id AND a.user_id = ?)))
                OR p.owner_user_id = ?
             ORDER BY (p.owner_user_id IS NOT NULL), p.is_default DESC, p.name`
        )
        .all(user.id, user.id);
}

function canUsePool(user, poolId) {
    if (!user || !poolId) return false;
    if (user.role === 'admin') return !!getPool(poolId);
    const p = getPool(poolId);
    if (!p) return false;
    if (p.owner_user_id) return p.owner_user_id === user.id;
    if (p.visibility === 'all') return true;
    if (user.pool_id === p.id) return true; // admin-set override
    return !!db.get().prepare('SELECT 1 FROM pool_access WHERE pool_id = ? AND user_id = ?').get(poolId, user.id);
}

function getPoolAccess(poolId) {
    return db.get().prepare('SELECT user_id FROM pool_access WHERE pool_id = ?').all(poolId).map((r) => r.user_id);
}

/** Replaces the list of users an admin pool is assigned to. */
function setPoolAccess(poolId, userIds) {
    const conn = db.get();
    const ids = [...new Set((userIds || []).filter(isId))];
    conn.transaction(() => {
        conn.prepare('DELETE FROM pool_access WHERE pool_id = ?').run(poolId);
        for (const userId of ids) db.insert('pool_access', { pool_id: poolId, user_id: userId });
        conn.prepare(`UPDATE proxy_pools SET ${db.TOUCH} WHERE id = ?`).run(...db.touch(), poolId);
    })();
    cache.clear();
    return getPoolAccess(poolId);
}

/** The user's personal pool, created on first use. */
function getOrCreatePersonalPool(user) {
    const conn = db.get();
    const existing = conn.prepare('SELECT * FROM proxy_pools WHERE owner_user_id = ? ORDER BY id LIMIT 1').get(user.id);
    if (existing) return existing;
    const id = db.insert('proxy_pools', {
        name: `${user.username} - personal`,
        type: 'other',
        is_default: 0,
        owner_user_id: user.id,
        visibility: 'assigned',
        description: 'Proxies added by the user'
    });
    cache.clear();
    return getPool(id);
}

function getPersonalPool(userId) {
    return db.get().prepare('SELECT * FROM proxy_pools WHERE owner_user_id = ? ORDER BY id LIMIT 1').get(userId) || null;
}

function countUserProxies(userId) {
    return db
        .get()
        .prepare('SELECT COUNT(*) AS n FROM proxies x JOIN proxy_pools p ON p.id = x.pool_id WHERE p.owner_user_id = ?')
        .get(userId).n;
}

/**
 * Adds proxies to a user's personal pool. Every host must be public (no SSRF
 * into the server's own network), and the per-user limit applies.
 */
async function importUserProxies(user, text, defaultProtocol, maxPerUser) {
    const { proxies, errors } = parseProxyList(text, defaultProtocol);
    if (!proxies.length && !errors.length) throw new Error('Paste at least one proxy');
    const room = Math.max(0, maxPerUser - countUserProxies(user.id));
    const accepted = [];
    for (const p of proxies) {
        if (accepted.length >= room) {
            errors.push(`${p.host}:${p.port}: limit of ${maxPerUser} proxies reached`);
            continue;
        }
        try {
            await assertPublicHost(p.host);
            accepted.push(p);
        } catch (e) {
            errors.push(`${p.host}:${p.port}: ${e.message}`);
        }
    }
    if (!accepted.length) return { added: 0, skipped: 0, errors };
    const pool = getOrCreatePersonalPool(user);
    const lines = accepted
        .map((p) => `${p.protocol}://${p.username ? encodeURIComponent(p.username) + ':' + encodeURIComponent(p.password || '') + '@' : ''}${p.host.includes(':') ? '[' + p.host + ']' : p.host}:${p.port}`)
        .join('\n');
    const result = importProxies(pool.id, lines);
    return { ...result, errors: [...errors, ...result.errors], poolId: pool.id };
}

/** Proxy row (no secrets) if it belongs to the user's personal pool. */
function getOwnedProxy(userId, proxyId) {
    return (
        db
            .get()
            .prepare(`SELECT x.id, x.pool_id FROM proxies x JOIN proxy_pools p ON p.id = x.pool_id WHERE x.id = ? AND p.owner_user_id = ?`)
            .get(proxyId, userId) || null
    );
}

function getPool(id) {
    return db.get().prepare('SELECT * FROM proxy_pools WHERE id = ?').get(id) || null;
}

function getPoolByName(name) {
    return db.get().prepare('SELECT * FROM proxy_pools WHERE name = ?').get(name) || null;
}

/** Creates/updates an ADMIN pool. visibility: 'all' | 'assigned'. */
function savePool({ id, name, country = null, type = 'datacenter', isDefault = false, description = null, visibility = 'all' }) {
    if (!name || String(name).length > 80) throw new Error('Pool name is required (max 80 chars)');
    if (!POOL_TYPES.includes(type)) throw new Error(`Pool type must be one of: ${POOL_TYPES.join(', ')}`);
    if (!['all', 'assigned'].includes(visibility)) throw new Error('Visibility must be "all" or "assigned"');
    const conn = db.get();
    const tx = conn.transaction(() => {
        if (isDefault) conn.prepare(`UPDATE proxy_pools SET is_default = 0, ${db.TOUCH} WHERE is_default = 1`).run(...db.touch());
        if (id) {
            conn.prepare(`UPDATE proxy_pools SET name = ?, country = ?, type = ?, is_default = ?, description = ?, visibility = ?, ${db.TOUCH} WHERE id = ? AND owner_user_id IS NULL`).run(
                name,
                country || null,
                type,
                isDefault ? 1 : 0,
                description || null,
                visibility,
                ...db.touch(),
                id
            );
            return id;
        }
        // The very first admin pool automatically becomes the default.
        const first = conn.prepare('SELECT COUNT(*) AS n FROM proxy_pools WHERE owner_user_id IS NULL').get().n === 0;
        return db.insert('proxy_pools', { name, country: country || null, type, is_default: isDefault || first ? 1 : 0, description: description || null, visibility });
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
    enabled, status, latency_ms, fail_count, last_checked_at, last_error, created_at, created_by, updated_at, updated_by`;

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

/** One lazy-loaded batch of a pool's proxies (in import order). `status` filters healthy/slow/dead/unknown/disabled. */
function pageProxies(poolId, { status = '', q = '' } = {}, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const where = ['pool_id = ?'];
    const args = [poolId];
    if (status === 'disabled') where.push('enabled = 0');
    else if (status) {
        where.push('enabled = 1 AND status = ?'); // same buckets as proxySummary()
        args.push(String(status));
    }
    if (q) {
        where.push('host LIKE ?');
        args.push(`%${String(q).slice(0, 100)}%`);
    }
    const after = paging.decodeCursor(cursor);
    if (after) {
        where.push('id > ?');
        args.push(String(after[0]));
    }
    args.push(n + 1);
    const rows = db
        .get()
        .prepare(
            `SELECT ${PROXY_PUBLIC},
                (SELECT COUNT(*) FROM sessions s WHERE s.proxy_id = proxies.id AND s.ended_at IS NULL) AS active_sessions
             FROM proxies WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`
        )
        .all(...args);
    return paging.toPage(rows, n, (r) => [r.id]);
}

/** Status counts for the whole pool. */
function proxySummary(poolId) {
    const r = db
        .get()
        .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN enabled = 1 AND status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
                    SUM(CASE WHEN enabled = 1 AND status = 'slow' THEN 1 ELSE 0 END) AS slow,
                    SUM(CASE WHEN enabled = 1 AND status = 'dead' THEN 1 ELSE 0 END) AS dead,
                    SUM(CASE WHEN enabled = 1 AND status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
                    SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END) AS disabled,
                    CAST(AVG(CASE WHEN status <> 'dead' THEN latency_ms END) AS INTEGER) AS avg_latency
             FROM proxies WHERE pool_id = ?`
        )
        .get(poolId);
    const k = (v) => v || 0;
    return { total: r.total, healthy: k(r.healthy), slow: k(r.slow), dead: k(r.dead), unknown: k(r.unknown), disabled: k(r.disabled), avgLatency: r.avg_latency };
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
    let added = 0;
    const tx = db.get().transaction(() => {
        for (const p of proxies) {
            if (db.insert('proxies', { pool_id: poolId, protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password }, { orIgnore: true })) added += 1;
        }
    });
    tx();
    cache.clear();
    return { added, skipped: proxies.length - added, errors };
}

function setProxyEnabled(id, enabled) {
    db.get().prepare(`UPDATE proxies SET enabled = ?, ${db.TOUCH} WHERE id = ?`).run(enabled ? 1 : 0, ...db.touch(), id);
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
    conn.prepare(`UPDATE proxies SET status = ?, latency_ms = ?, fail_count = ?, last_checked_at = ?, last_error = ?, ${db.TOUCH} WHERE id = ?`).run(
        status,
        ok ? latencyMs : null,
        failCount,
        Date.now(),
        ok ? null : String(error || 'failed').slice(0, 300),
        ...db.touch(),
        id
    );
    db.insert('proxy_checks', { proxy_id: id, ok: ok ? 1 : 0, latency_ms: ok ? latencyMs : null, error: ok ? null : String(error || 'failed').slice(0, 200) });
    cache.delete('proxy:' + id);
    return status;
}

// ------------------------------------------------------------ selection ----
function defaultPoolId() {
    return cache.get('defaultPool', () => {
        const row = db.get().prepare('SELECT id FROM proxy_pools WHERE is_default = 1 AND owner_user_id IS NULL LIMIT 1').get();
        return row ? row.id : null;
    });
}

/**
 * Decides which pool a new session uses (order documented at the top of this file).
 * @param {object} user  row from users service
 * @param {string} startUrl
 * @param {object[]} sites enabled sites
 * @param {number} [requestedPoolId] pool picked by the user on the landing page
 */
function resolvePoolId(user, startUrl, sites, requestedPoolId = null) {
    if (isId(requestedPoolId) && canUsePool(user, requestedPoolId)) return requestedPoolId;
    if (user && user.pool_id) return user.pool_id;
    const host = hostOf(startUrl);
    if (host) {
        const site = sites.find((s) => s.pool_id && matchesAny(host, s.domains));
        if (site && (!user || !user.id || canUsePool(user, site.pool_id))) return site.pool_id;
    }
    const def = defaultPoolId();
    if (def && (!user || !user.id || canUsePool(user, def))) return def;
    const personal = user && user.id ? getPersonalPool(user.id) : null;
    return personal ? personal.id : null;
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

/** Last health checks of one proxy (newest first) - Admin -> proxy history. */
function proxyChecks(proxyId, limit = 100) {
    return db.get().prepare('SELECT created_at AS ts, ok, latency_ms, error FROM proxy_checks WHERE proxy_id = ? ORDER BY id DESC LIMIT ?').all(proxyId, limit);
}

function isUsable(proxy) {
    return !!proxy && proxy.enabled === 1 && proxy.status !== 'dead';
}

module.exports = {
    POOL_TYPES,
    pageProxies,
    proxySummary,
    listPools,
    listAccessiblePools,
    canUsePool,
    getPoolAccess,
    setPoolAccess,
    getOrCreatePersonalPool,
    getPersonalPool,
    countUserProxies,
    importUserProxies,
    getOwnedProxy,
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
    proxyChecks,
    clearCache: () => cache.clear()
};
