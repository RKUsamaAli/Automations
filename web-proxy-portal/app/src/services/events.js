'use strict';
/**
 * Audit/event log: logins, sessions, blocked domains, rate limits, proxy health.
 * Shown on the admin dashboard. Old rows are pruned by the maintenance job.
 */
const db = require('../db');
const paging = require('../lib/paging');
const log = require('../lib/logger')('events');

function record(type, { userId = null, detail = null, ip = null } = {}) {
    try {
        db.get()
            .prepare('INSERT INTO events (user_id, type, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(userId, type, detail == null ? null : String(detail).slice(0, 1000), ip, Date.now());
    } catch (e) {
        // Logging must never break a request.
        log.warn(`failed to record event ${type}`, e);
    }
}

function list({ limit = 100, userId = null, type = null } = {}) {
    const where = [];
    const args = [];
    if (userId) {
        where.push('e.user_id = ?');
        args.push(userId);
    }
    if (type) {
        where.push('e.type = ?');
        args.push(type);
    }
    args.push(Math.min(Number(limit) || 100, 1000));
    return db
        .get()
        .prepare(
            `SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY e.id DESC LIMIT ?`
        )
        .all(...args);
}

function evWhere({ userId = null, type = null } = {}) {
    const where = [];
    const args = [];
    if (userId) {
        where.push('e.user_id = ?');
        args.push(Number(userId));
    }
    if (type) {
        where.push('e.type = ?');
        args.push(String(type));
    }
    return { where, args };
}
const sqlWhere = (w) => (w.length ? 'WHERE ' + w.join(' AND ') : '');

/** One lazy-loaded batch, newest first. */
function page(f = {}, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const { where, args } = evWhere(f);
    const after = paging.decodeCursor(cursor);
    if (after) {
        where.push('e.id < ?');
        args.push(Number(after[0]));
    }
    args.push(n + 1);
    const rows = db
        .get()
        .prepare(`SELECT e.*, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id ${sqlWhere(where)} ORDER BY e.id DESC LIMIT ?`)
        .all(...args);
    return paging.toPage(rows, n, (r) => [r.id]);
}

/** Totals for the whole filtered set: count, users, and the most frequent event types. */
function pageSummary(f = {}) {
    const { where, args } = evWhere(f);
    const conn = db.get();
    const t = conn.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT e.user_id) AS users, MIN(e.created_at) AS first_at FROM events e ${sqlWhere(where)}`).get(...args);
    const types = conn.prepare(`SELECT e.type, COUNT(*) AS n FROM events e ${sqlWhere(where)} GROUP BY e.type ORDER BY n DESC LIMIT 6`).all(...args);
    return { total: t.total, users: t.users, firstAt: t.first_at, types };
}

function prune(olderThanDays = 30) {
    const cutoff = Date.now() - olderThanDays * 86400000;
    return db.get().prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes;
}

module.exports = { record, list, page, pageSummary, prune };
