'use strict';
/**
 * Audit/event log: logins, sessions, blocked domains, rate limits, proxy health.
 * Shown on the admin dashboard. Old rows are pruned by the maintenance job.
 */
const db = require('../db');
const context = require('../lib/context');
const system = require('../lib/system');
const paging = require('../lib/paging');
// Which process is writing: set once by each entry point (web server, proxy, cli, jobs).
let DEFAULT_SOURCE = 'system';
function setSource(source) {
    DEFAULT_SOURCE = source;
}

/**
 * Stores one action in the activity log (Admin -> Activity log).
 *
 *   events.record('admin_user_updated', {
 *       userId,              // who did it (null = system)
 *       detail,              // short human text: "alice: role user -> admin"
 *       ip, requestId,
 *       source,              // web | proxy | cli | job | deploy | system (default: this process)
 *       target,              // 'user:12', 'pool:3' ...
 *       changes,             // { role: ['user', 'admin'] } - see lib/audit.js diff()
 *       level                // info (default) | warn | error
 *   });
 *
 * Never throws: logging must not break the action it describes.
 */
function record(type, { userId = null, detail = null, ip = null, requestId = null, source = null, target = null, changes = null, level = 'info', clientId = null } = {}) {
    try {
        const ctx = context.get();
        db.insert('events', {
            type,
            level,
            source: source || (ctx && ctx.source) || DEFAULT_SOURCE,
            detail: detail == null ? null : String(detail).slice(0, 1000),
            target,
            changes: changes && Object.keys(changes).length ? JSON.stringify(changes).slice(0, 4000) : null,
            ip: ip || (ctx && ctx.ip) || null,
            request_id: requestId || (ctx && ctx.requestId) || null,
            client_id: clientId || (ctx && ctx.clientId) || null,
            ...system.info(), // server, process, release
            // who did it: explicit userId, else the signed-in user of this request
            created_by: userId || context.actor(),
            updated_by: userId || context.actor()
        });
    } catch (e) {
        // Logging must never break a request. Use the console directly (not
        // the stored log) so a broken database cannot cause a loop.
        process.stderr.write(`[events] failed to record ${type}: ${e.message}\n`);
    }
}

function list({ limit = 100, userId = null, type = null } = {}) {
    const where = [];
    const args = [];
    if (userId) {
        where.push('e.created_by = ?');
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
            `SELECT e.*, e.created_by AS user_id, u.username, ${DEVICE_COLS} FROM events e LEFT JOIN users u ON u.id = e.created_by ${DEVICE_JOIN}
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY e.id DESC LIMIT ?`
        )
        .all(...args);
}

function evWhere({ userId = null, type = null, source = null, level = null, target = null, q = null } = {}) {
    const where = [];
    const args = [];
    if (source) {
        where.push('e.source = ?');
        args.push(String(source));
    }
    if (level) {
        where.push(level === 'problems' ? "e.level IN ('warn','error')" : 'e.level = ?');
        if (level !== 'problems') args.push(String(level));
    }
    if (target) {
        where.push('e.target = ?');
        args.push(String(target));
    }
    if (q) {
        where.push("(e.detail LIKE ? OR e.type LIKE ? OR e.request_id = ? OR e.target = ?)");
        const like = `%${String(q).slice(0, 100)}%`;
        args.push(like, like, String(q), String(q));
    }
    if (userId) {
        where.push('e.created_by = ?');
        args.push(String(userId));
    }
    if (type) {
        where.push('e.type = ?');
        args.push(String(type));
    }
    return { where, args };
}
// Device summary columns shown in lists (full details: clientDevices.get()).
const DEVICE_COLS = 'd.browser, d.browser_version, d.os, d.os_version, d.device_type, d.device_model, d.screen';
const DEVICE_JOIN = 'LEFT JOIN client_devices d ON d.id = e.client_id';

/** One entry with everything known about it (Admin -> Activity log -> details). */
function getOne(id) {
    const row = db
        .get()
        .prepare(`SELECT e.*, e.created_by AS user_id, u.username FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`)
        .get(id);
    if (!row) return null;
    return { ...row, changes: row.changes ? JSON.parse(row.changes) : null, client: row.client_id ? require('./clientDevices').get(row.client_id) : null };
}
const sqlWhere = (w) => (w.length ? 'WHERE ' + w.join(' AND ') : '');

/** One lazy-loaded batch, newest first. */
function page(f = {}, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const { where, args } = evWhere(f);
    const after = paging.decodeCursor(cursor);
    if (after) {
        where.push('e.id < ?');
        args.push(String(after[0]));
    }
    args.push(n + 1);
    const rows = db
        .get()
        .prepare(`SELECT e.*, e.created_by AS user_id, u.username, ${DEVICE_COLS} FROM events e LEFT JOIN users u ON u.id = e.created_by ${DEVICE_JOIN} ${sqlWhere(where)} ORDER BY e.id DESC LIMIT ?`)
        .all(...args);
    return paging.toPage(rows, n, (r) => [r.id]);
}

/** Totals for the whole filtered set: count, users, and the most frequent event types. */
function pageSummary(f = {}) {
    const { where, args } = evWhere(f);
    const conn = db.get();
    const t = conn.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT e.created_by) AS users, MIN(e.created_at) AS first_at, SUM(CASE WHEN e.level IN ('warn','error') THEN 1 ELSE 0 END) AS problems FROM events e ${sqlWhere(where)}`).get(...args);
    const types = conn.prepare(`SELECT e.type, COUNT(*) AS n FROM events e ${sqlWhere(where)} GROUP BY e.type ORDER BY n DESC LIMIT 6`).all(...args);
    return { total: t.total, users: t.users, firstAt: t.first_at, problems: t.problems || 0, types };
}

function prune(olderThanDays = 30) {
    const cutoff = Date.now() - olderThanDays * 86400000;
    return db.get().prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes;
}

module.exports = { record, list, page, pageSummary, getOne, prune, setSource };
