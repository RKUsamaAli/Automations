'use strict';
/**
 * Error reports - one row per failure, with everything needed to reproduce it:
 * the error, the request, the upstream proxy / destination and the TRAIL of
 * steps the user took before it happened (breadcrumbs + their recent events).
 *
 * The user is shown the reference (e.g. "E-7K2P9Q") so they can tell the admin
 * exactly which failure they hit; the admin finds it under Admin -> Errors.
 *
 * Flood protection:
 *   - the same error (fingerprint) for the same user/session within 2 minutes
 *     only increments `occurrences` on the existing report;
 *   - at most 60 new reports per minute per process.
 */
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const events = require('./events');
const requestLog = require('./requestLog');
const RateLimiter = require('../lib/rateLimiter');
const { redactUrl, redactObject, redactText } = require('../lib/redact');
const log = require('../lib/logger')('errors');

const DEDUPE_MS = 2 * 60000;
const limiter = new RateLimiter(60000);
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I - easy to read out loud

function newRef() {
    const bytes = crypto.randomBytes(6);
    let s = '';
    for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
    return 'E-' + s;
}

/** Stable id for "the same problem": kind + where + message without numbers/ids. */
function fingerprintOf(kind, where, message) {
    const normalized = String(message || '')
        .replace(/\b[0-9a-f]{8,}\b/gi, '#')
        .replace(/\d+/g, '#')
        .slice(0, 200);
    return crypto.createHash('sha1').update(`${kind}|${where || ''}|${normalized}`).digest('hex').slice(0, 16);
}

/**
 * Records a failure. Never throws (reporting must not cause a second error).
 * @param {object} r
 * @param {'web'|'proxy'|'client'} r.source
 * @param {string} r.kind            e.g. page_load_failed, server_exception, client_js, api_error, site_error
 * @param {'error'|'warning'} [r.severity]
 * @param {string|Error} r.error     message or Error (stack is kept)
 * @param {number} [r.userId]  @param {string} [r.sessionId]  @param {string} [r.requestId]
 * @param {string} [r.url]     @param {string} [r.destHost]   @param {number} [r.proxyId]  @param {number} [r.poolId]
 * @param {string} [r.clientIp] @param {string} [r.userAgent]
 * @param {object} [r.context]       anything useful (redacted before saving)
 * @param {object[]} [r.breadcrumbs] steps before the error
 * @returns {string|null} reference shown to the user
 */
function report(r) {
    try {
        const message = redactText(r.error instanceof Error ? r.error.message : r.error || 'Unknown error');
        const stack = r.error instanceof Error && r.error.stack ? redactText(r.error.stack) : r.stack ? redactText(r.stack) : null;
        const where = r.destHost || (r.url ? String(r.url).split('?')[0].slice(0, 120) : '');
        const fingerprint = fingerprintOf(r.kind, r.source === 'proxy' ? r.destHost : where, message);
        const now = Date.now();
        const conn = db.get();

        // Same problem, same user/session, just now -> count it instead of a new report.
        const recent = conn
            .prepare(
                `SELECT id, ref FROM error_reports
                 WHERE fingerprint = ? AND IFNULL(user_id, 0) = ? AND IFNULL(session_id, '') = ? AND last_seen_at > ?
                 ORDER BY id DESC LIMIT 1`
            )
            .get(fingerprint, r.userId || 0, r.sessionId || '', now - DEDUPE_MS);
        if (recent) {
            conn.prepare('UPDATE error_reports SET occurrences = occurrences + 1, last_seen_at = ? WHERE id = ?').run(now, recent.id);
            return recent.ref;
        }
        if (!limiter.hit('reports', 60)) {
            log.warn('error report rate limit reached, report dropped', { kind: r.kind, message });
            return null;
        }

        const ref = newRef();
        // Recent portal-level actions of this user (sign-in, session start, ...) complete the picture.
        const recentEvents = r.userId ? events.list({ userId: r.userId, limit: 15 }).reverse() : [];
        // Stored activity from the OTHER process (the in-memory trail only knows its own):
        // a portal error gets the user's recent proxied pages and vice versa.
        let stored = [];
        if (r.userId) {
            requestLog.flush();
            const own = r.source === 'client' ? 'web' : r.source;
            stored = requestLog
                .recentForUser(r.userId, 20)
                .filter((row) => row.source !== own)
                .map((row) => ({ t: row.ts, type: row.kind === 'page' ? 'page' : row.kind === 'resource' ? 'resource' : 'api', method: row.method, url: row.url, status: row.status || 'failed', ms: row.ms }));
        }
        const trail = [
            ...recentEvents.map((e) => ({ t: e.created_at, type: 'event', event: e.type, detail: e.detail })),
            ...stored,
            ...(r.breadcrumbs || [])
        ].sort((a, b) => a.t - b.t);

        conn.prepare(
            `INSERT INTO error_reports (ref, created_at, last_seen_at, source, kind, severity, fingerprint, message, stack,
                user_id, session_id, request_id, release, url, dest_host, proxy_id, pool_id, client_ip, user_agent, context, breadcrumbs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            ref,
            now,
            now,
            r.source,
            r.kind,
            r.severity === 'warning' ? 'warning' : 'error',
            fingerprint,
            message,
            stack,
            r.userId || null,
            r.sessionId || null,
            r.requestId || null,
            config.releaseName,
            r.url ? redactUrl(r.url) : null,
            r.destHost || null,
            r.proxyId || null,
            r.poolId || null,
            r.clientIp || null,
            r.userAgent ? String(r.userAgent).slice(0, 300) : null,
            JSON.stringify(redactObject(r.context || {})),
            JSON.stringify(redactObject(trail.slice(-60)))
        );
        log.error(`${r.kind}: ${message}`, { ref, source: r.source, user: r.userId || null, session: r.sessionId ? r.sessionId.slice(0, 8) : null, requestId: r.requestId || null, dest: r.destHost || null });
        return ref;
    } catch (e) {
        log.error('failed to save error report', e);
        return null;
    }
}

const parse = (row) =>
    row && {
        ...row,
        context: row.context ? JSON.parse(row.context) : {},
        breadcrumbs: row.breadcrumbs ? JSON.parse(row.breadcrumbs) : []
    };

function get(refOrId) {
    const row = db
        .get()
        .prepare(`SELECT e.*, u.username FROM error_reports e LEFT JOIN users u ON u.id = e.user_id WHERE e.ref = ? OR e.id = ?`)
        .get(String(refOrId).toUpperCase(), Number(refOrId) || -1);
    return parse(row) || null;
}

/**
 * @param {object} f
 * @param {'open'|'resolved'|'all'} [f.status]
 * @param {string} [f.q] search in ref / message / host / username
 */
function list({ status = 'open', q = '', limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status === 'open') where.push('e.resolved = 0');
    if (status === 'resolved') where.push('e.resolved = 1');
    if (q) {
        where.push('(e.ref LIKE ? OR e.message LIKE ? OR e.dest_host LIKE ? OR u.username LIKE ? OR e.kind LIKE ?)');
        const like = `%${String(q).slice(0, 100)}%`;
        args.push(like, like, like, like, like);
    }
    args.push(Math.min(Number(limit) || 200, 1000));
    return db
        .get()
        .prepare(
            `SELECT e.id, e.ref, e.created_at, e.last_seen_at, e.occurrences, e.source, e.kind, e.severity, e.fingerprint,
                    e.message, e.user_id, u.username, e.session_id, e.url, e.dest_host, e.resolved,
                    (SELECT COUNT(*) FROM error_reports g WHERE g.fingerprint = e.fingerprint) AS group_count
             FROM error_reports e LEFT JOIN users u ON u.id = e.user_id
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY e.last_seen_at DESC LIMIT ?`
        )
        .all(...args);
}

function setResolved(id, resolved, byUserId, note) {
    db.get()
        .prepare('UPDATE error_reports SET resolved = ?, resolved_at = ?, resolved_by = ?, note = COALESCE(?, note) WHERE id = ?')
        .run(resolved ? 1 : 0, resolved ? Date.now() : null, resolved ? byUserId : null, note ?? null, id);
}

/** Resolves every report with the same fingerprint ("fixed this bug"). */
function resolveGroup(fingerprint, byUserId) {
    return db
        .get()
        .prepare('UPDATE error_reports SET resolved = 1, resolved_at = ?, resolved_by = ? WHERE fingerprint = ? AND resolved = 0')
        .run(Date.now(), byUserId, fingerprint).changes;
}

function countOpen() {
    return db.get().prepare('SELECT COUNT(*) AS n FROM error_reports WHERE resolved = 0').get().n;
}

/** All reports in a time range as plain objects (JSON Lines export for analysis). */
function exportRange(sinceMs) {
    return db
        .get()
        .prepare(`SELECT e.*, u.username FROM error_reports e LEFT JOIN users u ON u.id = e.user_id WHERE e.created_at >= ? ORDER BY e.id`)
        .all(sinceMs)
        .map(parse);
}

function prune(olderThanDays = 30) {
    return db.get().prepare('DELETE FROM error_reports WHERE last_seen_at < ?').run(Date.now() - olderThanDays * 86400000).changes;
}

module.exports = { report, get, list, setResolved, resolveGroup, countOpen, exportRange, prune, fingerprintOf };
