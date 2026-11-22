'use strict';
/**
 * Request log - what users did, successful or not.
 *
 * REQUEST_LOG_LEVEL (shared/.env):
 *   pages (default) - proxied page views + failed sub-requests + portal actions
 *   all             - also every successful image/script/XHR (much more data)
 *   off             - only failures
 *
 * Rows are buffered in memory and written in one transaction every 2 s, so
 * logging never slows a request down. Each process flushes its own buffer.
 */
const db = require('../db');
const { redactUrl } = require('../lib/redact');
const log = require('../lib/logger')('request-log');

const LEVEL = () => (process.env.REQUEST_LOG_LEVEL || 'pages').toLowerCase();
const MAX_BUFFER = 5000;
let buffer = [];
let timer = null;

/** Should this request be stored? */
function wanted(kind, status) {
    const failed = !status || status >= 400;
    const level = LEVEL();
    if (failed) return true;
    if (level === 'off') return false;
    if (level === 'all') return true;
    return kind !== 'resource';
}

/**
 * @param {object} r { source, kind, userId, sessionId, method, url, host, status, ms, bytes, proxyId, requestId, error }
 */
function add(r) {
    if (!wanted(r.kind, r.status)) return;
    if (buffer.length >= MAX_BUFFER) buffer.shift(); // never grow without bound if the DB is stuck
    buffer.push([
        Date.now(),
        r.source,
        r.kind,
        r.userId || null,
        r.sessionId || null,
        r.method || null,
        r.url ? redactUrl(r.url) : null,
        r.host || null,
        r.status == null ? null : Number(r.status) || 0,
        r.ms == null ? null : Math.round(r.ms),
        r.bytes == null ? null : r.bytes,
        r.proxyId || null,
        r.requestId || null,
        r.error ? String(r.error).slice(0, 300) : null
    ]);
    if (!timer) {
        timer = setTimeout(flush, 2000);
        timer.unref();
    }
}

function flush() {
    timer = null;
    if (!buffer.length) return;
    const rows = buffer;
    buffer = [];
    try {
        const conn = db.get();
        const stmt = conn.prepare(
            `INSERT INTO request_log (ts, source, kind, user_id, session_id, method, url, host, status, ms, bytes, proxy_id, request_id, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        conn.transaction(() => {
            for (const r of rows) stmt.run(...r);
        })();
    } catch (e) {
        log.error(`could not write ${rows.length} request log rows`, e);
    }
}

/**
 * Filtered list for Admin -> Requests.
 * @param {object} f { userId, sessionId, kind, status ('ok'|'failed'|code), q, since, limit }
 */
function list(f = {}) {
    const where = [];
    const args = [];
    const filter = (sql, value) => {
        where.push(sql);
        if (value !== undefined) args.push(value);
    };
    if (f.userId) filter('r.user_id = ?', Number(f.userId));
    if (f.sessionId) filter('r.session_id = ?', String(f.sessionId));
    // 'activity' = what a person did: proxied pages, portal page views, portal
    // actions that change something (not background GETs), and every failure.
    if (f.kind === 'activity') filter("(r.kind IN ('page','view') OR (r.kind = 'api' AND r.method <> 'GET') OR r.status = 0 OR r.status >= 400)");
    else if (f.kind) filter('r.kind = ?', String(f.kind));
    if (f.status === 'failed') filter('(r.status = 0 OR r.status >= 400)');
    else if (f.status === 'ok') filter('r.status > 0 AND r.status < 400');
    else if (/^\d{3}$/.test(String(f.status || ''))) filter('r.status = ?', Number(f.status));
    if (f.q) {
        const like = `%${String(f.q).slice(0, 100)}%`;
        where.push('(r.url LIKE ? OR r.host LIKE ? OR r.request_id = ? OR u.username LIKE ?)');
        args.push(like, like, String(f.q), like);
    }
    if (f.since) filter('r.ts >= ?', Number(f.since));
    args.push(Math.min(Number(f.limit) || 200, 2000));
    return db
        .get()
        .prepare(
            `SELECT r.*, u.username FROM request_log r LEFT JOIN users u ON u.id = r.user_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT ?`
        )
        .all(...args);
}

/** Everything one browsing session did, oldest first. */
function sessionTimeline(sessionId, limit = 500) {
    return db.get().prepare('SELECT * FROM request_log WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse();
}

/** Recent rows for a user (used to enrich error reports). */
function recentForUser(userId, limit = 20) {
    return db.get().prepare('SELECT * FROM request_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit).reverse();
}

/** Requests / failures / median+p95 per 10 minutes over the last `hours`. */
function summary(hours = 24) {
    const since = Date.now() - hours * 3600000;
    return db
        .get()
        .prepare(
            `SELECT (ts / 600000) * 600000 AS bucket, COUNT(*) AS requests,
                    SUM(CASE WHEN status = 0 OR status >= 500 THEN 1 ELSE 0 END) AS failures,
                    CAST(AVG(ms) AS INTEGER) AS avg_ms
             FROM request_log WHERE ts >= ? AND kind IN ('page','api') GROUP BY bucket ORDER BY bucket`
        )
        .all(since);
}

function prune(days = 14) {
    return db.get().prepare('DELETE FROM request_log WHERE ts < ?').run(Date.now() - days * 86400000).changes;
}

module.exports = { add, flush, list, sessionTimeline, recentForUser, summary, prune, wanted };
