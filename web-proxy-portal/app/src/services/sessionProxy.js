'use strict';
/**
 * Which upstream proxy a browsing session uses, and changing it.
 *
 *   choices(user, session)  -> pools the user may use, each with its proxies
 *                              (no passwords), the current one marked
 *   change(session, proxyId, { user, admin }) -> moves the session
 *
 * The proxy engine re-reads the session row on every request (2-second
 * cache), so the next page load already goes out through the new proxy.
 * The site's cookies / logins stay; sites that tie a login to the IP address
 * may ask the user to sign in again.
 */
const db = require('../db');
const pools = require('./pools');
const sessions = require('./sessions');
const events = require('./events');

/** "yneehewk-ES-19 @ p.webshare.io:80" - username matters for Webshare-style endpoints. */
function label(x) {
    if (!x) return 'direct (server IP)';
    return `${x.username ? x.username + ' @ ' : ''}${x.host}:${x.port}`;
}

function poolsFor(user, admin) {
    if (admin) return pools.listPools();
    return pools.listAccessiblePools(user);
}

function choices(user, session, { admin = false } = {}) {
    const out = [];
    for (const p of poolsFor(admin ? null : user, admin)) {
        if (admin && p.owner_user_id && p.owner_user_id !== session.user_id) continue; // never another user's own proxies
        const proxies = db
            .get()
            .prepare(
                `SELECT id, protocol, host, port, username, status, latency_ms, enabled, exit_ip, exit_country, exit_country_code, exit_city, exit_isp,
                        (SELECT COUNT(*) FROM sessions s WHERE s.proxy_id = proxies.id AND s.ended_at IS NULL) AS active_sessions
                 FROM proxies WHERE pool_id = ? ORDER BY (status = 'dead'), latency_ms IS NULL, latency_ms, id`
            )
            .all(p.id)
            .map((x) => ({ ...x, label: label(x), usable: pools.isUsable(x), current: x.id === session.proxy_id }));
        const scores = pools.proxyScores(proxies.map((x) => x.id));
        for (const x of proxies) x.score = scores.get(x.id).score;
        if (proxies.length) out.push({ id: p.id, name: p.owner_user_id ? 'My proxies' : p.name, country: p.country, proxies });
    }
    return out;
}

function change(session, proxyId, { user, admin = false }) {
    if (!session || session.ended_at || session.end_requested) throw new Error('That session has ended');
    const proxy = pools.getProxyWithSecrets(proxyId);
    if (!proxy || !pools.isUsable(proxy)) throw new Error('That proxy is not available (offline or disabled)');
    const pool = pools.getPool(proxy.pool_id);
    if (!pool) throw new Error('Proxy pool not found');
    if (admin) {
        if (pool.owner_user_id && pool.owner_user_id !== session.user_id) throw new Error("That is another user's own proxy");
    } else if (!pools.canUsePool(user, pool.id)) {
        throw new Error('You are not allowed to use that proxy');
    }
    const before = session.proxy_id ? pools.getProxyWithSecrets(session.proxy_id) : null;
    if (before && before.id === proxy.id) return { changed: false, proxy: label(proxy) };
    sessions.setPoolAndProxy(session.id, pool.id, proxy.id);
    events.record(admin ? 'admin_session_proxy_changed' : 'session_proxy_changed', {
        userId: user.id,
        target: `session:${session.id}`,
        detail: `${label(before)} -> ${label(proxy)} (session ${session.id.slice(0, 8)}, ${session.start_url || ''})`,
        changes: { proxy: [label(before), label(proxy)], pool: [session.pool_id, pool.id] }
    });
    return { changed: true, proxy: label(proxy), pool: pool.owner_user_id ? 'My proxies' : pool.name };
}

module.exports = { choices, change, label };
