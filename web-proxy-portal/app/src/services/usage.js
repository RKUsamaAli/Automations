'use strict';
/**
 * Usage accounting (requests + bytes) per user, and per session.
 *
 * Stored in 15-minute UTC slots (usage_slots), so totals can be grouped into
 * the calendar days of ANY time zone: "today" for a viewer in Karachi starts at
 * Karachi midnight, not UTC midnight. See lib/timezone.js.
 *
 * The proxy engine calls `track()` for every proxied response. Counters are
 * kept in memory and flushed to SQLite every few seconds (`flush()`), so the
 * hot path never waits on the database. With several Rammerhead workers each
 * worker flushes its own deltas - the UPSERT adds them up correctly.
 */
const db = require('../db');
const sessionsService = require('./sessions');
const TtlCache = require('../lib/ttlCache');
const tzlib = require('../lib/timezone');

const SLOT_MS = 15 * 60000;
const slotOf = (ms) => Math.floor(ms / SLOT_MS) * SLOT_MS;

let pendingUsers = new Map(); // `${userId}|${slot}` -> { requests, bytes }
let pendingSessions = new Map(); // sessionId -> { requests, bytes, lastSeen }
const dbTodayCache = new TtlCache(30000);

function track(userId, sessionId, bytes) {
    const ukey = `${userId}|${slotOf(Date.now())}`;
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
        `INSERT INTO usage_slots (user_id, slot, requests, bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, slot) DO UPDATE SET requests = requests + excluded.requests, bytes = bytes + excluded.bytes`
    );
    const tx = conn.transaction(() => {
        for (const [key, v] of users) {
            const [userId, slot] = key.split('|');
            upsert.run(Number(userId), Number(slot), v.requests, v.bytes);
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

/**
 * Bytes a user used since THEIR local midnight (DB + not-yet-flushed).
 * Used for the daily traffic cap. `tz` = the user's browser time zone.
 */
function bytesToday(userId, tz) {
    const since = tzlib.startOfDay(tzlib.normalize(tz));
    const fromDb = dbTodayCache.get(`${userId}|${since}`, () => {
        const row = db.get().prepare('SELECT SUM(bytes) AS b FROM usage_slots WHERE user_id = ? AND slot >= ?').get(userId, since);
        return row && row.b ? row.b : 0;
    });
    let pending = 0;
    for (const [key, v] of pendingUsers) {
        const [uid, slot] = key.split('|');
        if (Number(uid) === userId && Number(slot) >= since) pending += v.bytes;
    }
    return fromDb + pending;
}

/** Per-user totals since local midnight `days - 1` days ago in `tz` (admin panel). */
function summary(days = 7, tz = 'UTC') {
    const since = tzlib.startOfDayAgo(tzlib.normalize(tz), days - 1);
    return db
        .get()
        .prepare(
            `SELECT u.id AS user_id, u.username, COALESCE(SUM(s.requests),0) AS requests, COALESCE(SUM(s.bytes),0) AS bytes
             FROM users u LEFT JOIN usage_slots s ON s.user_id = u.id AND s.slot >= ?
             GROUP BY u.id ORDER BY bytes DESC`
        )
        .all(since);
}

/**
 * Totals per LOCAL calendar day in `tz` for the last `days` days, oldest first.
 * Every day is present (zeros included): [{ day: 'YYYY-MM-DD', requests, bytes }]
 */
function daily(days = 14, tz = 'UTC') {
    tz = tzlib.normalize(tz);
    const since = tzlib.startOfDayAgo(tz, days - 1);
    const rows = db
        .get()
        .prepare('SELECT slot, SUM(requests) AS requests, SUM(bytes) AS bytes FROM usage_slots WHERE slot >= ? GROUP BY slot ORDER BY slot')
        .all(since);
    const byDay = new Map();
    for (let i = days - 1; i >= 0; i--) {
        const key = tzlib.dayKey(tzlib.startOfDayAgo(tz, i), tz);
        byDay.set(key, { day: key, requests: 0, bytes: 0 });
    }
    for (const r of rows) {
        const d = byDay.get(tzlib.dayKey(r.slot, tz));
        if (!d) continue;
        d.requests += r.requests;
        d.bytes += r.bytes;
    }
    return [...byDay.values()];
}

/** Today's totals (local day in `tz`). */
function today(tz = 'UTC') {
    const r = db.get().prepare('SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(bytes),0) AS bytes FROM usage_slots WHERE slot >= ?').get(tzlib.startOfDay(tzlib.normalize(tz)));
    return { requests: r.requests, bytes: r.bytes };
}

function prune(days = 180) {
    return db.get().prepare('DELETE FROM usage_slots WHERE slot < ?').run(Date.now() - days * 86400000).changes;
}

module.exports = { track, flush, bytesToday, summary, daily, today, prune, SLOT_MS };
