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
const sessionProxy = require('../../services/sessionProxy');
const webSearch = require('../../services/webSearch');
const search = require('../../services/search');
const RateLimiter = require('../../lib/rateLimiter');
const { idOrNull } = require('../../lib/ids');
const context = require('../../lib/context');
const suggest = require('../../services/suggest');
const users = require('../../services/users');
const sessions = require('../../services/sessions');
const pools = require('../../services/pools');
const healthCheck = require('../../jobs/healthCheck');
const { isBug } = require('../../lib/errors');
const settings = require('../../services/settings');
const events = require('../../services/events');
const { hostOf } = require('../../lib/domainMatch');
const { mintTicket } = require('../../lib/authTokens');
const { isPrivateHost } = require('../../lib/netGuard');
const { normalizeUrl } = require('../../lib/urlInput');

const router = express.Router();

/** Device of the current request (browser / OS / screen), passed to the proxy in the ticket. */
const clientId = () => {
    const c = context.get();
    return c ? c.clientId : null;
};

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

// Google results via the server's headless browser (search worker), through
// the chosen connection: via=direct or a pool id. 20 searches / minute / user.
const searchLimiter = new RateLimiter(60000);
router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Type something to search for' });
    if (!searchLimiter.hit(`s:${req.user.id}`, 20)) return res.status(429).json({ error: 'Too many searches. Wait a moment.' });
    try {
        const via = webSearch.proxyFor(req.user, String(req.query.via || 'direct'));
        const lang = String(req.get('accept-language') || 'en').split(',')[0].slice(0, 5);
        const r = await webSearch.search({ q, proxy: via.proxy, lang });
        events.record('search', { userId: req.user.id, detail: `${r.engine}${r.cached ? ' (cached)' : ''} via ${via.label}: ${q.slice(0, 200)}` });
        res.json({ ...r, via: via.label });
    } catch (e) {
        res.status(e.status || 502).json({ error: e.message });
    }
});

// Search suggestions for the address bar (engine's own, cached; 20/10 s per user).
const suggestLimiter = new RateLimiter(10000);
router.get('/search-suggest', async (req, res) => {
    const q = String(req.query.q || '');
    const kind = search.classify(q);
    if (!suggestLimiter.hit(`sg:${req.user.id}`, 20)) return res.json({ engine: search.engine().name, kind: kind.type, suggestions: [] });
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ engine: search.engine().name, kind: kind.type, suggestions: kind.type === 'search' || q.length < 40 ? await search.suggestions(q) : [] });
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
    const wantsDirect = req.body && req.body.poolId === 'direct';
    if (wantsDirect && !settings.get('allow_direct')) return res.status(403).json({ error: 'Browsing without a proxy is turned off by the administrator. Pick a proxy.' });
    const poolId = wantsDirect ? 'direct' : req.body ? idOrNull(req.body.poolId) : null;
    if (poolId && poolId !== 'direct' && !pools.canUsePool(user, poolId)) {
        return res.status(403).json({ error: 'You are not allowed to use that proxy pool.' });
    }

    // Resume an existing session (keeps the site's cookies/logins).
    if (sessionId) {
        const s = sessions.get(String(sessionId));
        if (!s || s.user_id !== user.id || s.ended_at || s.end_requested) {
            return res.status(404).json({ error: 'That session has ended. Start a new one.' });
        }
        const ticket = mintTicket({ uid: user.id, v: user.token_version, sid: s.id, url: url ? safeUrl(url) : null, cid: clientId(), until: req.token && req.token.idx });
        return res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
    }

    let target;
    let searchQuery = null;
    try {
        if (siteId) {
            const site = sites.listEnabled().find((s) => s.id === String(siteId));
            if (!site) return res.status(404).json({ error: 'Site not found' });
            target = site.start_url;
        } else {
            // Words -> results page of the search engine; an address -> that site.
            const kind = search.classify(url);
            if (kind.type === 'empty') throw new Error('Type a website address or something to search for');
            target = normalizeUrl(kind.type === 'search' ? kind.url : kind.input);
            if (kind.type === 'search') searchQuery = kind.query;
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

    if (searchQuery) events.record('search', { userId: user.id, detail: `${search.engine().name}: ${searchQuery.slice(0, 200)}` });
    const ticket = mintTicket({ uid: user.id, v: user.token_version, url: target, pool: poolId, cid: clientId(), until: req.token && req.token.idx });
    res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
});

function safeUrl(url) {
    try {
        return normalizeUrl(url);
    } catch (_) {
        return null;
    }
}

// Preferences: the floating toolbar on proxied pages.
router.put('/preferences', (req, res) => {
    const b = req.body || {};
    if (typeof b.toolbarEnabled !== 'boolean') return res.status(400).json({ error: 'toolbarEnabled must be true or false' });
    const u = users.setToolbar(req.user.id, b.toolbarEnabled);
    events.record(b.toolbarEnabled ? 'toolbar_enabled' : 'toolbar_disabled', { userId: req.user.id, detail: 'Account page' });
    res.json({ toolbarEnabled: u.toolbar_enabled === 1 });
});

// Which proxy a session uses, and switching it (next page load uses the new one).
router.get('/sessions/:id/proxies', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
    res.json({ current: s.proxy_id, pools: sessionProxy.choices(req.user, s) });
});
router.post('/sessions/:id/proxy', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
    try {
        res.json(sessionProxy.change(s, String((req.body || {}).proxyId || ''), { user: req.user }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

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
        events.record('user_proxies_added', {
            userId: req.user.id,
            detail: `${result.added} added, ${result.skipped || 0} duplicates, ${result.errors.length} rejected`,
            target: result.poolId ? `pool:${result.poolId}` : null,
            level: result.added ? 'info' : 'warn'
        });
        if (result.added) {
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
        events.record('user_proxies_checked', { userId: req.user.id, detail: `${result.checked} checked, ${result.healthy || 0} online, ${result.dead || 0} offline`, target: `pool:${pool.id}` });
        res.json(result);
    } catch (e) {
        next(e);
    }
});

router.patch('/proxies/:id', requireUserProxies, (req, res) => {
    const owned = pools.getOwnedProxy(req.user.id, String(req.params.id));
    if (!owned) return res.status(404).json({ error: 'Proxy not found' });
    const x = pools.getProxyWithSecrets(owned.id);
    const enabled = !!(req.body || {}).enabled;
    pools.setProxyEnabled(owned.id, enabled);
    events.record(enabled ? 'user_proxy_enabled' : 'user_proxy_disabled', { userId: req.user.id, detail: `${x.protocol}://${x.host}:${x.port}`, target: `proxy:${owned.id}` });
    res.json({ ok: true });
});

router.delete('/proxies/:id', requireUserProxies, (req, res) => {
    const owned = pools.getOwnedProxy(req.user.id, String(req.params.id));
    if (!owned) return res.status(404).json({ error: 'Proxy not found' });
    const x = pools.getProxyWithSecrets(owned.id);
    pools.deleteProxy(owned.id);
    events.record('user_proxy_removed', { userId: req.user.id, detail: `${x.protocol}://${x.host}:${x.port}`, target: `proxy:${owned.id}` });
    res.json({ ok: true });
});

module.exports = router;
module.exports.normalizeUrl = normalizeUrl;
module.exports.isPrivateHost = isPrivateHost;
