'use strict';
/**
 * Browsing session records (the DB side of a Rammerhead session).
 *
 * Rammerhead keeps the actual session (cookies, localStorage) in
 * shared/data/sessions/<id>.rhfsession. This table adds who owns it, which
 * upstream proxy it is stuck to, and usage counters for the admin panel.
 */
const db = require('../db');
const paging = require('../lib/paging');
const TtlCache = require('../lib/ttlCache');

// Short TTL: the portal (another process) ends sessions by writing the DB,
// and the proxy must notice quickly. A primary-key lookup is microseconds.
const cache = new TtlCache(2000);

function create({ id, userId, poolId, proxyId, startUrl, clientIp, userAgent }) {
    const now = Date.now();
    db.get()
        .prepare(
            `INSERT INTO sessions (id, user_id, pool_id, proxy_id, start_url, client_ip, user_agent, created_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, userId, poolId || null, proxyId || null, startUrl ? String(startUrl).slice(0, 2000) : null, clientIp || null, userAgent ? String(userAgent).slice(0, 300) : null, now, now);
    cache.delete(id);
}

function get(id) {
    return db.get().prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

/** Cached lookup used on every proxied request. */
function getCached(id) {
    return cache.get(id, () => get(id));
}

function setProxy(id, proxyId) {
    db.get().prepare('UPDATE sessions SET proxy_id = ? WHERE id = ?').run(proxyId || null, id);
    cache.delete(id);
}

function listActiveForUser(userId) {
    return db
        .get()
        .prepare(
            `SELECT s.id, s.start_url, s.created_at, s.last_seen_at, s.requests, s.bytes, p.name AS pool_name
             FROM sessions s LEFT JOIN proxy_pools p ON p.id = s.pool_id
             WHERE s.user_id = ? AND s.ended_at IS NULL AND s.end_requested = 0
             ORDER BY s.last_seen_at DESC`
        )
        .all(userId);
}

function countActiveForUser(userId) {
    return db.get().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND ended_at IS NULL AND end_requested = 0').get(userId).n;
}

function listActive(limit = 200) {
    return db
        .get()
        .prepare(
            `SELECT s.*, u.username, p.name AS pool_name, x.host AS proxy_host, x.port AS proxy_port
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             LEFT JOIN proxy_pools p ON p.id = s.pool_id
             LEFT JOIN proxies x ON x.id = s.proxy_id
             WHERE s.ended_at IS NULL ORDER BY s.last_seen_at DESC LIMIT ?`
        )
        .all(limit);
}

/** One lazy-loaded batch of active sessions, most recently used first. Cursor = (last_seen_at, id). */
function pageActive({ cursor = null, limit, userId = null } = {}) {
    const n = paging.limitOf(limit);
    const after = paging.decodeCursor(cursor);
    const args = [];
    let extra = '';
    if (userId) {
        extra += ' AND s.user_id = ?';
        args.push(Number(userId));
    }
    if (after) {
        extra += ' AND (s.last_seen_at < ? OR (s.last_seen_at = ? AND s.id < ?))';
        args.push(Number(after[0]), Number(after[0]), String(after[1]));
    }
    args.push(n + 1);
    const rows = db
        .get()
        .prepare(
            `SELECT s.*, u.username, p.name AS pool_name, x.host AS proxy_host, x.port AS proxy_port
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             LEFT JOIN proxy_pools p ON p.id = s.pool_id
             LEFT JOIN proxies x ON x.id = s.proxy_id
             WHERE s.ended_at IS NULL ${extra} ORDER BY s.last_seen_at DESC, s.id DESC LIMIT ?`
        )
        .all(...args);
    return paging.toPage(rows, n, (r) => [r.last_seen_at, r.id]);
}

/** Totals over ALL active sessions (optionally of one user). */
function activeSummary({ userId = null } = {}) {
    const r = db
        .get()
        .prepare(
            `SELECT COUNT(*) AS total, COUNT(DISTINCT user_id) AS users, SUM(requests) AS requests, SUM(bytes) AS bytes,
                    SUM(CASE WHEN end_requested = 1 THEN 1 ELSE 0 END) AS ending
             FROM sessions WHERE ended_at IS NULL ${userId ? 'AND user_id = ?' : ''}`
        )
        .get(...(userId ? [Number(userId)] : []));
    return { total: r.total, users: r.users, requests: r.requests || 0, bytes: r.bytes || 0, ending: r.ending || 0 };
}

function listRecent(limit = 100) {
    return db
        .get()
        .prepare(
            `SELECT s.*, u.username FROM sessions s LEFT JOIN users u ON u.id = s.user_id
             ORDER BY s.created_at DESC LIMIT ?`
        )
        .all(limit);
}

/** Portal asks for a session to end; the proxy process executes it (see jobs/sessionSync.js). */
function requestEnd(id) {
    db.get().prepare('UPDATE sessions SET end_requested = 1 WHERE id = ? AND ended_at IS NULL').run(id);
    cache.delete(id);
}

function requestEndForUser(userId) {
    db.get().prepare('UPDATE sessions SET end_requested = 1 WHERE user_id = ? AND ended_at IS NULL').run(userId);
    cache.clear();
}

function markEnded(id, reason) {
    db.get().prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), reason, id);
    cache.delete(id);
}

function listEndRequested() {
    return db.get().prepare('SELECT id FROM sessions WHERE end_requested = 1 AND ended_at IS NULL').all().map((r) => r.id);
}

function listActiveIds() {
    return db.get().prepare('SELECT id FROM sessions WHERE ended_at IS NULL').all().map((r) => r.id);
}

/** Adds usage deltas collected in memory by the proxy engine. */
function addUsage(id, requests, bytes, lastSeenAt) {
    db.get()
        .prepare('UPDATE sessions SET requests = requests + ?, bytes = bytes + ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?')
        .run(requests, bytes, lastSeenAt, id);
}

function stats() {
    const conn = db.get();
    return {
        active: conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get().n,
        today: conn.prepare('SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?').get(new Date().setUTCHours(0, 0, 0, 0)).n
    };
}

function pruneEnded(olderThanDays = 30) {
    return db.get().prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(Date.now() - olderThanDays * 86400000).changes;
}

module.exports = {
    pageActive,
    activeSummary,
    create,
    get,
    getCached,
    setProxy,
    listActiveForUser,
    countActiveForUser,
    listActive,
    listRecent,
    requestEnd,
    requestEndForUser,
    markEnded,
    listEndRequested,
    listActiveIds,
    addUsage,
    stats,
    pruneEnded,
    invalidate: (id) => cache.delete(id)
};
