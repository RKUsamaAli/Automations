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
const paging = require('../lib/paging');
const { newId } = require('../lib/ids');
const system = require('../lib/system');
const sessions = require('./sessions');
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
    // Column order matches flush(): created_at, created_by (= the user who made the request), ...
    buffer.push([
        Date.now(),
        r.userId || null,
        r.source,
        r.kind,
        r.sessionId || null,
        r.method || null,
        r.url ? redactUrl(r.url) : null,
        r.host || null,
        r.status == null ? null : Number(r.status) || 0,
        r.ms == null ? null : Math.round(r.ms),
        r.bytes == null ? null : r.bytes,
        r.proxyId || null,
        r.requestId || null,
        r.error ? String(r.error).slice(0, 300) : null,
        r.ip || null,
        r.clientId || null
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
            `INSERT INTO request_log (id, created_at, created_by, updated_at, updated_by, source, kind, session_id, method, url, host, status, ms, bytes, proxy_id, request_id, error, ip, client_id, server, process)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const { server, process: proc } = system.info();
        conn.transaction(() => {
            for (const r of rows) {
                // Proxied requests: the device is the one that started the browsing session.
                if (!r[15] && r[4]) {
                    const s = sessions.getCached(r[4]);
                    r[15] = s ? s.client_id : null;
                }
                // id = GUID v7 from the time the request happened, so ORDER BY id = time order
                stmt.run(newId(r[0]), r[0], r[1], r[0], r[1], ...r.slice(2), server, proc);
            }
        })();
    } catch (e) {
        log.error(`could not write ${rows.length} request log rows`, e);
    }
}

/**
 * WHERE clause shared by the list, the paged list and the summary.
 * @param {object} f { userId, sessionId, kind, status ('ok'|'failed'|code), q, since }
 */
function whereFor(f = {}) {
    const where = [];
    const args = [];
    const filter = (sql, value) => {
        where.push(sql);
        if (value !== undefined) args.push(value);
    };
    if (f.userId) filter('r.created_by = ?', String(f.userId));
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
    if (f.since) filter('r.created_at >= ?', Number(f.since));
    return { where, args };
}

const FROM = 'FROM request_log r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN client_devices d ON d.id = r.client_id';
const DEVICE_COLS = 'd.browser, d.browser_version, d.os, d.os_version, d.device_type, d.device_model, d.screen';
const whereSql = (where) => (where.length ? 'WHERE ' + where.join(' AND ') : '');

/** Filtered list for Admin -> Requests (CSV export, tests). Newest first. */
function list(f = {}) {
    const { where, args } = whereFor(f);
    args.push(Math.min(Number(f.limit) || 200, 2000));
    return db.get().prepare(`SELECT r.*, r.created_at AS ts, r.created_by AS user_id, u.username, ${DEVICE_COLS} ${FROM} ${whereSql(where)} ORDER BY r.id DESC LIMIT ?`).all(...args);
}

/**
 * One batch for the lazy-loaded table: newest first, continuing after `cursor`.
 * @returns {{items: object[], nextCursor: string|null}}
 */
function page(f = {}, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const { where, args } = whereFor(f);
    const after = paging.decodeCursor(cursor);
    if (after) {
        where.push('r.id < ?');
        args.push(String(after[0]));
    }
    args.push(n + 1);
    const rows = db.get().prepare(`SELECT r.*, r.created_at AS ts, r.created_by AS user_id, u.username, ${DEVICE_COLS} ${FROM} ${whereSql(where)} ORDER BY r.id DESC LIMIT ?`).all(...args);
    return paging.toPage(rows, n, (r) => [r.id]);
}

/** Totals over the WHOLE filtered set (shown above the table). */
function pageSummary(f = {}) {
    const { where, args } = whereFor(f);
    const row = db
        .get()
        .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN r.status = 0 OR r.status >= 400 THEN 1 ELSE 0 END) AS failed,
                    CAST(AVG(r.ms) AS INTEGER) AS avg_ms,
                    SUM(COALESCE(r.bytes, 0)) AS bytes,
                    COUNT(DISTINCT r.created_by) AS users,
                    COUNT(DISTINCT r.session_id) AS sessions
             ${FROM} ${whereSql(where)}`
        )
        .get(...args);
    return {
        total: row.total,
        failed: row.failed || 0,
        ok: row.total - (row.failed || 0),
        avgMs: row.avg_ms || 0,
        bytes: row.bytes || 0,
        users: row.users,
        sessions: row.sessions
    };
}

/** Everything one browsing session did, oldest first. */
function sessionTimeline(sessionId, limit = 500) {
    return db.get().prepare('SELECT *, created_at AS ts, created_by AS user_id FROM request_log WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, limit).reverse();
}

/** Lazy-loaded session timeline: newest first (the drawer shows the latest activity on top). */
function sessionTimelinePage(sessionId, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const after = paging.decodeCursor(cursor);
    const rows = after
        ? db.get().prepare('SELECT *, created_at AS ts, created_by AS user_id FROM request_log WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(sessionId, String(after[0]), n + 1)
        : db.get().prepare('SELECT *, created_at AS ts, created_by AS user_id FROM request_log WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, n + 1);
    return paging.toPage(rows, n, (r) => [r.id]);
}

/** Totals for one session's whole timeline. */
function sessionTimelineSummary(sessionId) {
    const r = db
        .get()
        .prepare(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN kind = 'page' THEN 1 ELSE 0 END) AS pages,
                    SUM(CASE WHEN status = 0 OR status >= 400 THEN 1 ELSE 0 END) AS failed,
                    SUM(COALESCE(bytes, 0)) AS bytes, MIN(created_at) AS first_ts, MAX(created_at) AS last_ts
             FROM request_log WHERE session_id = ?`
        )
        .get(sessionId);
    return { total: r.total, pages: r.pages || 0, failed: r.failed || 0, bytes: r.bytes || 0, firstTs: r.first_ts, lastTs: r.last_ts };
}

/** Recent rows for a user (used to enrich error reports). */
function recentForUser(userId, limit = 20) {
    return db.get().prepare('SELECT *, created_at AS ts, created_by AS user_id FROM request_log WHERE created_by = ? ORDER BY id DESC LIMIT ?').all(userId, limit).reverse();
}

/** Requests / failures / median+p95 per 10 minutes over the last `hours`. */
function summary(hours = 24) {
    const since = Date.now() - hours * 3600000;
    return db
        .get()
        .prepare(
            `SELECT (created_at / 600000) * 600000 AS bucket, COUNT(*) AS requests,
                    SUM(CASE WHEN status = 0 OR status >= 500 THEN 1 ELSE 0 END) AS failures,
                    CAST(AVG(ms) AS INTEGER) AS avg_ms
             FROM request_log WHERE created_at >= ? AND kind IN ('page','api') GROUP BY bucket ORDER BY bucket`
        )
        .all(since);
}

function prune(days = 14) {
    return db.get().prepare('DELETE FROM request_log WHERE created_at < ?').run(Date.now() - days * 86400000).changes;
}

module.exports = { add, flush, list, page, pageSummary, sessionTimeline, sessionTimelinePage, sessionTimelineSummary, recentForUser, summary, prune, wanted };
