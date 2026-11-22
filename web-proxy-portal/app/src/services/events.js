'use strict';
/**
 * Audit/event log: logins, sessions, blocked domains, rate limits, proxy health.
 * Shown on the admin dashboard. Old rows are pruned by the maintenance job.
 */
const db = require('../db');
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

function prune(olderThanDays = 30) {
    const cutoff = Date.now() - olderThanDays * 86400000;
    return db.get().prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes;
}

module.exports = { record, list, prune };
