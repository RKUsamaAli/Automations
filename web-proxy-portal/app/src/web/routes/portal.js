'use strict';
/**
 * User-facing API (landing page).
 *
 *   GET    /api/portal/sites            sites shown as tiles
 *   GET    /api/portal/pools            proxy pools I may browse through (picker)
 *   GET    /api/portal/sessions         my active browsing sessions
 *   POST   /api/portal/browse           { url | siteId | sessionId, poolId? }  -> { redirect }
 *   DELETE /api/portal/sessions/:id     end one of my sessions
 *
 *   My proxies (setting user_proxies_enabled):
 *   GET    /api/portal/proxies          my proxies + limit
 *   POST   /api/portal/proxies          { text, defaultProtocol }  import into my personal pool
 *   POST   /api/portal/proxies/check    health-check my proxies now
 *   PATCH  /api/portal/proxies/:id      { enabled }
 *   DELETE /api/portal/proxies/:id
 */
const express = require('express');
const config = require('../../config');
const sites = require('../../services/sites');
const suggest = require('../../services/suggest');
const sessions = require('../../services/sessions');
const pools = require('../../services/pools');
const healthCheck = require('../../jobs/healthCheck');
const { isBug } = require('../../lib/errors');
const settings = require('../../services/settings');
const events = require('../../services/events');
const { hostOf } = require('../../lib/domainMatch');
const { mintTicket } = require('../../lib/authTokens');
const { isPrivateHost } = require('../../lib/netGuard');

const router = express.Router();

/** Turns "example.com/path" into "https://example.com/path"; rejects non-http(s). */
function normalizeUrl(input) {
    let raw = String(input || '').trim();
    if (!raw) throw new Error('Enter a website address');
    if (raw.length > 4000) throw new Error('URL is too long');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
    let u;
    try {
        u = new URL(raw);
    } catch (_) {
        throw new Error('That does not look like a valid website address');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses are supported');
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a valid website address');
    // Never let users point the proxy at the server itself / private networks.
    if (isPrivateHost(u.hostname)) throw new Error('That address is not allowed');
    return u.toString();
}

router.get('/sites', (_req, res) => {
    res.json(
        sites
            .listEnabled()
            .filter((s) => s.show_on_landing)
            .map((s) => ({ id: s.id, name: s.name, startUrl: s.start_url, host: hostOf(s.start_url) }))
    );
});

router.get('/pools', (req, res) => {
    res.json(
        pools.listAccessiblePools(req.user).map((p) => ({
            id: p.id,
            name: p.owner_user_id ? 'My proxies' : p.name,
            country: p.country,
            type: p.type,
            personal: !!p.owner_user_id,
            isDefault: !!p.is_default,
            usable: p.usable_count,
            total: p.proxy_count
        }))
    );
});

// Address-bar suggestions: the user's recently opened pages.
router.get('/recent', (req, res) => {
    res.json(suggest.recentUrls(req.user.id, req.query.q || ''));
});

router.get('/sessions', (req, res) => {
    res.json(sessions.listActiveForUser(req.user.id));
});

router.post('/browse', (req, res) => {
    const { url, siteId, sessionId } = req.body || {};
    const user = req.user;
    const poolId = req.body && req.body.poolId ? Number(req.body.poolId) : null;
    if (poolId && !pools.canUsePool(user, poolId)) {
        return res.status(403).json({ error: 'You are not allowed to use that proxy pool.' });
    }

    // Resume an existing session (keeps the site's cookies/logins).
    if (sessionId) {
        const s = sessions.get(String(sessionId));
        if (!s || s.user_id !== user.id || s.ended_at || s.end_requested) {
            return res.status(404).json({ error: 'That session has ended. Start a new one.' });
        }
        const ticket = mintTicket({ uid: user.id, v: user.token_version, sid: s.id, url: url ? safeUrl(url) : null });
        return res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
    }

    let target;
    try {
        if (siteId) {
            const site = sites.listEnabled().find((s) => s.id === Number(siteId));
            if (!site) return res.status(404).json({ error: 'Site not found' });
            target = site.start_url;
        } else {
            target = normalizeUrl(url);
        }
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    if (!sites.isHostAllowed(hostOf(target))) {
        events.record('blocked_domain', { userId: user.id, detail: hostOf(target), ip: req.ip });
        return res.status(403).json({ error: 'This website is not on the list of allowed sites.' });
    }

    const max = settings.get('max_sessions_per_user');
    if (max && sessions.countActiveForUser(user.id) >= max) {
        return res.status(429).json({ error: `You already have ${max} active sessions. End one before starting another.` });
    }

    const ticket = mintTicket({ uid: user.id, v: user.token_version, url: target, pool: poolId });
    res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
});

function safeUrl(url) {
    try {
        return normalizeUrl(url);
    } catch (_) {
        return null;
    }
}

router.delete('/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
    sessions.requestEnd(s.id);
    events.record('session_end_requested', { userId: req.user.id, detail: s.id.slice(0, 8), ip: req.ip });
    res.json({ ok: true });
});

// ------------------------------------------------------------ my proxies ----
function requireUserProxies(_req, res, next) {
    if (!settings.get('user_proxies_enabled')) return res.status(403).json({ error: 'Adding your own proxies is disabled by the administrator.' });
    next();
}

router.get('/proxies', requireUserProxies, (req, res) => {
    const pool = pools.getPersonalPool(req.user.id);
    res.json({
        limit: settings.get('max_proxies_per_user'),
        poolId: pool ? pool.id : null,
        proxies: pool ? pools.listProxies(pool.id) : []
    });
});

router.post('/proxies', requireUserProxies, async (req, res, next) => {
    const { text, defaultProtocol } = req.body || {};
    try {
        const result = await pools.importUserProxies(req.user, text, defaultProtocol === 'socks5' ? 'socks5' : 'http', settings.get('max_proxies_per_user'));
        if (result.added) {
            events.record('user_proxies_added', { userId: req.user.id, detail: `+${result.added}`, ip: req.ip });
            healthCheck.checkAll({ poolId: result.poolId }).catch(() => {});
        }
        res.json(result);
    } catch (e) {
        if (isBug(e)) return next(e);
        res.status(400).json({ error: e.message });
    }
});

router.post('/proxies/check', requireUserProxies, async (req, res, next) => {
    try {
        const pool = pools.getPersonalPool(req.user.id);
        if (!pool) return res.json({ checked: 0 });
        const result = await healthCheck.checkAll({ poolId: pool.id });
        if (result.skipped) return res.status(409).json({ error: 'A check is already running, try again in a moment.' });
        res.json(result);
    } catch (e) {
        next(e);
    }
});

router.patch('/proxies/:id', requireUserProxies, (req, res) => {
    const owned = pools.getOwnedProxy(req.user.id, Number(req.params.id));
    if (!owned) return res.status(404).json({ error: 'Proxy not found' });
    pools.setProxyEnabled(owned.id, !!(req.body || {}).enabled);
    res.json({ ok: true });
});

router.delete('/proxies/:id', requireUserProxies, (req, res) => {
    const owned = pools.getOwnedProxy(req.user.id, Number(req.params.id));
    if (!owned) return res.status(404).json({ error: 'Proxy not found' });
    pools.deleteProxy(owned.id);
    res.json({ ok: true });
});

module.exports = router;
module.exports.normalizeUrl = normalizeUrl;
module.exports.isPrivateHost = isPrivateHost;
