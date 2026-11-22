'use strict';
/**
 * Time zones.
 *
 * Rule of the app: the DATABASE stores UTC only (epoch milliseconds). The
 * browser sends its IANA zone in the `X-Timezone` header (e.g. Asia/Karachi)
 * and the server uses it only where a calendar day matters: "today",
 * per-day charts, daily limits and the local-time column of exports.
 *
 * Built on Intl (no dependencies); handles DST and +5:30 / +5:45 zones.
 */

const DEFAULT_TZ = 'UTC';
const fmtCache = new Map();

function formatter(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        fmtCache.set(tz, f);
    }
    return f;
}

/** True for a real IANA zone name ("Europe/London", "UTC"). */
function isValid(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
    try {
        formatter(tz);
        return true;
    } catch (_) {
        return false;
    }
}

/** A safe zone: the given one if valid, else UTC. */
function normalize(tz) {
    return isValid(tz) ? tz : DEFAULT_TZ;
}

/** Wall-clock parts of `ms` in `tz`. */
function parts(ms, tz) {
    const out = {};
    for (const p of formatter(normalize(tz)).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
    return out;
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (Karachi = +300). */
function offsetMinutes(tz, ms = Date.now()) {
    const p = parts(ms, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** "+05:00" style label. */
function offsetLabel(tz, ms = Date.now()) {
    const m = offsetMinutes(tz, ms);
    const sign = m < 0 ? '-' : '+';
    const a = Math.abs(m);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Local calendar day of `ms` in `tz`: "YYYY-MM-DD". */
function dayKey(ms, tz) {
    const p = parts(ms, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** UTC instant (ms) of local midnight of the day containing `ms` in `tz`. */
function startOfDay(tz, ms = Date.now()) {
    const p = parts(ms, tz);
    const guess = Date.UTC(p.year, p.month - 1, p.day);
    // Correct by the offset at that moment (twice, in case midnight sits next to a DST change).
    let t = guess - offsetMinutes(tz, guess) * 60000;
    t = guess - offsetMinutes(tz, t) * 60000;
    return t;
}

/** Local midnight `days` days before today's (days = 0 -> today). */
function startOfDayAgo(tz, days, ms = Date.now()) {
    let t = startOfDay(tz, ms);
    for (let i = 0; i < days; i++) t = startOfDay(tz, t - 3600000); // step back over each local midnight (DST-safe)
    return t;
}

/** "2026-11-22 20:15:03 +05:00" - local wall time for exports. */
function formatLocal(ms, tz) {
    if (ms == null) return '';
    const p = parts(ms, tz);
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${offsetLabel(tz, ms)}`;
}

module.exports = { DEFAULT_TZ, isValid, normalize, offsetMinutes, offsetLabel, dayKey, startOfDay, startOfDayAgo, formatLocal };
