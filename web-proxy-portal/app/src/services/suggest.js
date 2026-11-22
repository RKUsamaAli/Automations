'use strict';
/**
 * Type-ahead suggestions for search boxes and form fields.
 *
 * Every function returns at most `limit` options shaped
 *   { value, label, hint?, id? }
 * `value` is what goes into the box, `label` what the list shows.
 * Matching is case-insensitive "contains", with prefix matches first, so
 * typing "al" shows "alice" before "kalani".
 */
const db = require('../db');

const LIMIT = 8;
const clean = (q) => String(q || '').trim().slice(0, 100);
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
const prefix = (q) => `${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

/** Users by username or e-mail. */
function users(q, { limit = LIMIT, pending = null } = {}) {
    q = clean(q);
    const args = [like(q), like(q)];
    let extra = '';
    if (pending != null) {
        extra = 'AND pending = ?';
        args.push(pending ? 1 : 0);
    }
    args.push(prefix(q), limit);
    return db
        .get()
        .prepare(
            `SELECT id, username, email, role, enabled, pending FROM users
             WHERE (username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ${extra}
             ORDER BY (username LIKE ? ESCAPE '\\') DESC, username COLLATE NOCASE LIMIT ?`
        )
        .all(...args)
        .map((u) => ({
            id: u.id,
            value: u.username,
            label: u.username,
            hint: [u.email, u.role === 'admin' ? 'admin' : null, u.pending ? 'awaiting approval' : u.enabled ? null : 'disabled'].filter(Boolean).join(' · ')
        }));
}

/**
 * Website hosts people actually use: hosts seen in the request log over the
 * last `days` (most used first) plus the hosts of configured sites.
 */
function hosts(q, { limit = LIMIT, days = 14 } = {}) {
    q = clean(q).toLowerCase();
    const seen = db
        .get()
        .prepare(
            `SELECT host, COUNT(*) AS n FROM request_log
             WHERE ts >= ? AND host IS NOT NULL AND host <> '' AND source = 'proxy' AND host LIKE ? ESCAPE '\\'
             GROUP BY host ORDER BY (host LIKE ? ESCAPE '\\') DESC, n DESC LIMIT ?`
        )
        .all(Date.now() - days * 86400000, like(q), prefix(q), limit * 2);
    const out = new Map();
    for (const s of db.get().prepare('SELECT name, start_url FROM sites ORDER BY sort_order, name').all()) {
        let host = '';
        try {
            host = new URL(s.start_url).hostname;
        } catch (_) {
            continue;
        }
        if (q && !host.includes(q) && !s.name.toLowerCase().includes(q)) continue;
        out.set(host, { value: host, label: host, hint: 'Site: ' + s.name });
    }
    for (const r of seen) if (!out.has(r.host)) out.set(r.host, { value: r.host, label: r.host, hint: r.n.toLocaleString('en-US') + ' requests' });
    return [...out.values()].slice(0, limit);
}

/**
 * Domain patterns for "Domain patterns" / "Run on domains" fields:
 * for each known host, the registrable-looking parent as *.parent plus the host.
 */
function domainPatterns(q, { limit = LIMIT } = {}) {
    q = clean(q).replace(/^\*\.?/, '').toLowerCase();
    const out = new Map();
    for (const h of hosts(q, { limit: 50, days: 30 })) {
        const parts = h.value.split('.');
        const parent = parts.length > 2 && !/^\d+$/.test(parts[parts.length - 1]) ? parts.slice(-2).join('.') : h.value;
        if (!out.has('*.' + parent)) out.set('*.' + parent, { value: '*.' + parent, label: '*.' + parent, hint: parent + ' and all its subdomains' });
        if (!out.has(h.value)) out.set(h.value, { value: h.value, label: h.value, hint: 'Only this host' });
    }
    return [...out.values()].slice(0, limit);
}

/** Proxy hosts inside one pool. */
function proxyHosts(poolId, q, { limit = LIMIT } = {}) {
    q = clean(q);
    return db
        .get()
        .prepare(
            `SELECT host, COUNT(*) AS n FROM proxies WHERE pool_id = ? AND host LIKE ? ESCAPE '\\'
             GROUP BY host ORDER BY (host LIKE ? ESCAPE '\\') DESC, host LIMIT ?`
        )
        .all(poolId, like(q), prefix(q), limit)
        .map((r) => ({ value: r.host, label: r.host, hint: r.n > 1 ? r.n + ' ports' : null }));
}

/** Error references matching what was typed (e.g. "E-7K"). */
function errorRefs(q, { limit = 5 } = {}) {
    q = clean(q).toUpperCase();
    if (q.length < 3 || !/^E-?[0-9A-Z]*$/.test(q)) return [];
    const ref = q.startsWith('E-') ? q : 'E-' + q.slice(1);
    return db
        .get()
        .prepare(`SELECT ref, message FROM error_reports WHERE ref LIKE ? ORDER BY last_seen_at DESC LIMIT ?`)
        .all(ref + '%', limit)
        .map((r) => ({ value: r.ref, label: r.ref, hint: r.message.slice(0, 60) }));
}

/** Pages a user opened recently (Browse page address bar). */
function recentUrls(userId, q, { limit = 6 } = {}) {
    q = clean(q).toLowerCase();
    const rows = db
        .get()
        .prepare('SELECT start_url, MAX(last_seen_at) AS t FROM sessions WHERE user_id = ? AND start_url IS NOT NULL GROUP BY start_url ORDER BY t DESC LIMIT 50')
        .all(userId);
    const out = [];
    const hostsSeen = new Set();
    for (const r of rows) {
        let host = '';
        try {
            host = new URL(r.start_url).hostname;
        } catch (_) {
            continue;
        }
        if (hostsSeen.has(host)) continue;
        if (q && !r.start_url.toLowerCase().includes(q)) continue;
        hostsSeen.add(host);
        out.push({ value: r.start_url, label: host.replace(/^www\./, ''), hint: r.start_url, t: r.t });
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { users, hosts, domainPatterns, proxyHosts, errorRefs, recentUrls, LIMIT };
