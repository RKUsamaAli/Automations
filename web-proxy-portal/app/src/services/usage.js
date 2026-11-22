'use strict';
/**
 * Usage accounting (requests + bytes) per user per day, and per session.
 *
 * The proxy engine calls `track()` for every proxied response. Counters are
 * kept in memory and flushed to SQLite every few seconds (`flush()`), so the
 * hot path never waits on the database. With several Rammerhead workers each
 * worker flushes its own deltas - the UPSERT adds them up correctly.
 */
const db = require('../db');
const sessionsService = require('./sessions');
const TtlCache = require('../lib/ttlCache');

const today = () => new Date().toISOString().slice(0, 10);

let pendingUsers = new Map(); // `${userId}|${day}` -> { requests, bytes }
let pendingSessions = new Map(); // sessionId -> { requests, bytes, lastSeen }
const dbTodayCache = new TtlCache(30000);

function track(userId, sessionId, bytes) {
    const day = today();
    const ukey = `${userId}|${day}`;
    const u = pendingUsers.get(ukey) || { requests: 0, bytes: 0 };
    u.requests += 1;
    u.bytes += bytes;
    pendingUsers.set(ukey, u);

    if (sessionId) {
        const s = pendingSessions.get(sessionId) || { requests: 0, bytes: 0, lastSeen: 0 };
        s.requests += 1;
        s.bytes += bytes;
        s.lastSeen = Date.now();
        pendingSessions.set(sessionId, s);
    }
}

function flush() {
    if (!pendingUsers.size && !pendingSessions.size) return;
    const users = pendingUsers;
    const sess = pendingSessions;
    pendingUsers = new Map();
    pendingSessions = new Map();
    const conn = db.get();
    const upsert = conn.prepare(
        `INSERT INTO usage_daily (user_id, day, requests, bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, day) DO UPDATE SET requests = requests + excluded.requests, bytes = bytes + excluded.bytes`
    );
    const tx = conn.transaction(() => {
        for (const [key, v] of users) {
            const [userId, day] = key.split('|');
            upsert.run(Number(userId), day, v.requests, v.bytes);
        }
        for (const [id, v] of sess) sessionsService.addUsage(id, v.requests, v.bytes, v.lastSeen);
    });
    try {
        tx();
        dbTodayCache.clear();
    } catch (e) {
        // Put the numbers back so they are retried on the next flush.
        for (const [k, v] of users) {
            const cur = pendingUsers.get(k) || { requests: 0, bytes: 0 };
            pendingUsers.set(k, { requests: cur.requests + v.requests, bytes: cur.bytes + v.bytes });
        }
        for (const [k, v] of sess) {
            const cur = pendingSessions.get(k) || { requests: 0, bytes: 0, lastSeen: 0 };
            pendingSessions.set(k, { requests: cur.requests + v.requests, bytes: cur.bytes + v.bytes, lastSeen: Math.max(cur.lastSeen, v.lastSeen) });
        }
        throw e;
    }
}

/** Bytes used today by a user (DB + not-yet-flushed). Used for the daily cap. */
function bytesToday(userId) {
    const day = today();
    const fromDb = dbTodayCache.get(`${userId}|${day}`, () => {
        const row = db.get().prepare('SELECT bytes FROM usage_daily WHERE user_id = ? AND day = ?').get(userId, day);
        return row ? row.bytes : 0;
    });
    const pending = pendingUsers.get(`${userId}|${day}`);
    return fromDb + (pending ? pending.bytes : 0);
}

/** Per-user totals for the last N days (admin panel). */
function summary(days = 7) {
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    return db
        .get()
        .prepare(
            `SELECT u.id AS user_id, u.username, COALESCE(SUM(d.requests),0) AS requests, COALESCE(SUM(d.bytes),0) AS bytes
             FROM users u LEFT JOIN usage_daily d ON d.user_id = u.id AND d.day >= ?
             GROUP BY u.id ORDER BY bytes DESC`
        )
        .all(since);
}

function daily(days = 14) {
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    return db
        .get()
        .prepare('SELECT day, SUM(requests) AS requests, SUM(bytes) AS bytes FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day')
        .all(since);
}

module.exports = { track, flush, bytesToday, summary, daily };
