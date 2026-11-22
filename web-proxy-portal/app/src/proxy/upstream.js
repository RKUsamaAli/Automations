'use strict';
/**
 * Sticky upstream proxy handling for Rammerhead sessions.
 *
 * A session is assigned ONE upstream proxy when it is created
 * (sessions.proxy_id) and keeps it until the session ends - per-request
 * rotation would break logins, CSRF tokens and multi-step flows.
 *
 * On every request `applyToSession()` makes sure the Rammerhead session
 * object points at that proxy, via Rammerhead's `overrideExternalProxySettings`
 * hook. Nothing proxy-related is written into the session file, so changing a
 * proxy's credentials in the admin panel takes effect without touching sessions.
 *
 * If the assigned proxy dies and `upstream_failover` is on, the session is
 * moved to another healthy proxy IN THE SAME POOL (the site sees a new IP once;
 * better than a dead session).
 */
const pools = require('../services/pools');
const sessions = require('../services/sessions');
const settings = require('../services/settings');
const events = require('../services/events');
const socksBridge = require('./socksBridge');
const { describeProxy } = require('../lib/proxyString');
const log = require('../lib/logger')('upstream');

/** Builds hammerhead's externalProxySettings object for an HTTP proxy. */
function hammerheadSettings(host, port, username, password) {
    const h = host.includes(':') ? `[${host}]` : host; // IPv6 literal
    const settingsObj = { host: `${h}:${port}`, hostname: host, port: String(port) };
    if (username) {
        const auth = `${username}:${password || ''}`;
        settingsObj.proxyAuth = auth;
        settingsObj.authHeader = 'Basic ' + Buffer.from(auth).toString('base64');
    }
    return settingsObj;
}

async function settingsFor(proxy) {
    if (proxy.protocol === 'socks5') {
        const bridge = await socksBridge.getBridge(proxy);
        return hammerheadSettings('127.0.0.1', bridge.port, bridge.user, bridge.pass);
    }
    return hammerheadSettings(proxy.host, proxy.port, proxy.username, proxy.password);
}

/**
 * Chooses the proxy for a NEW session.
 * @returns {{ poolId:number|null, proxy:object|null, error?:string }}
 */
function chooseForNewSession(user, startUrl, enabledSites, requestedPoolId = null) {
    const poolId = pools.resolvePoolId(user, startUrl, enabledSites, requestedPoolId);
    const proxy = pools.pickProxy(poolId);
    if (!proxy && settings.get('upstream_fallback') !== 'direct') {
        return {
            poolId,
            proxy: null,
            error: poolId
                ? 'No healthy upstream proxy is available in the assigned pool right now. Please try again later.'
                : 'No upstream proxy pool is configured yet. An admin needs to add proxies (or allow direct connections).'
        };
    }
    return { poolId, proxy };
}

/**
 * Points the Rammerhead session at its sticky proxy.
 * @param {object} session   RammerheadSession
 * @param {object} row       sessions table row
 * @returns {Promise<{ ok:true } | { ok:false, error:string }>}
 */
async function applyToSession(session, row) {
    let proxy = row.proxy_id ? pools.getProxyWithSecrets(row.proxy_id) : null;

    if (!pools.isUsable(proxy)) {
        const previous = proxy;
        // Session without proxy (created while none was available) or proxy died.
        if (row.proxy_id === null || settings.get('upstream_failover')) {
            const replacement = pools.pickProxy(row.pool_id, previous ? [previous.id] : []);
            if (replacement) {
                sessions.setProxy(row.id, replacement.id);
                row.proxy_id = replacement.id;
                proxy = replacement;
                if (previous) {
                    events.record('session_failover', { userId: row.user_id, detail: `${describeProxy(previous)} -> ${describeProxy(replacement)}` });
                    log.warn(`session ${row.id.slice(0, 8)} moved to ${describeProxy(replacement)}`);
                }
            } else proxy = null;
        } else proxy = null;
    }

    if (!proxy) {
        if (settings.get('upstream_fallback') === 'direct') {
            setOverride(session, 'direct', null);
            return { ok: true };
        }
        return { ok: false, error: 'The upstream proxy for this session is unavailable. Start a new session from the portal.' };
    }

    // Recompute only when the proxy (or its credentials) changed.
    const key = `${proxy.id}|${proxy.host}|${proxy.port}|${proxy.username || ''}|${proxy.password || ''}`;
    if (session.__portalUpstreamKey !== key) {
        setOverride(session, key, await settingsFor(proxy));
    }
    return { ok: true };
}

function setOverride(session, key, value) {
    session.__portalUpstreamKey = key;
    // Rammerhead reads this before the stored externalProxySettings.
    session.overrideExternalProxySettings = value;
    if (!value) session.externalProxySettings = null;
}

module.exports = { chooseForNewSession, applyToSession, hammerheadSettings };
