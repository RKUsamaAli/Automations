'use strict';
/**
 * Floating toolbar on proxied pages - server side (proxy hostname).
 *
 *   GET  /__portal/bar/state?sid=     current proxy, exit IP + location, other proxies, page
 *   POST /__portal/bar/go     {sid,q}        address or search words -> proxied URL in this session
 *   POST /__portal/bar/switch {sid,proxyId}  move the session to another proxy + check its exit IP
 *   POST /__portal/bar/check  {sid}          re-check the current proxy's exit IP / speed
 *   POST /__portal/bar/hide   {sid}          turn the toolbar off for this user (Account page turns it on)
 *
 * Every call needs:
 *   - the proxy sign-in cookie (checked by the guard before routes run: req.portalUser)
 *   - the session to belong to that user
 *   - header X-Portal-Bar = HMAC(session id): a per-session key that only the
 *     toolbar script itself holds (it is served inside /__portal/inject.js,
 *     which is only handed out to <script> loads, never to fetch()).
 *   - same-origin request (Sec-Fetch-Site), so other websites cannot call it.
 */
const crypto = require('crypto');
const config = require('../config');
const sessions = require('../services/sessions');
const sessionProxy = require('../services/sessionProxy');
const pools = require('../services/pools');
const users = require('../services/users');
const events = require('../services/events');
const search = require('../services/search');
const { normalizeUrl } = require('../lib/urlInput');
const { deriveKey } = require('../lib/crypto');
const log = require('../lib/logger')('toolbar');

/** Per-session key embedded in the toolbar script. */
function barKey(sid) {
    return crypto.createHmac('sha256', deriveKey(config.appSecret, 'toolbar')).update(String(sid)).digest('base64url').slice(0, 32);
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
}

function readJson(req, max = 4096) {
    return new Promise((resolve) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size <= max) chunks.push(c);
        });
        req.on('end', () => {
            try {
                resolve(size > max ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (_) {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

/** Checks user, session ownership, key and origin. -> { user, row } or null (response sent). */
function authorize(req, res, sid) {
    const user = req.portalUser;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') {
        sendJson(res, 403, { error: 'Not allowed' });
        return null;
    }
    if (!user) {
        sendJson(res, 401, { error: 'Not signed in' });
        return null;
    }
    const row = sid ? sessions.get(String(sid)) : null;
    const key = req.headers['x-portal-bar'];
    if (!row || row.user_id !== user.id || typeof key !== 'string' || key.length !== 32 || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(barKey(row.id)))) {
        sendJson(res, 403, { error: 'Not allowed' });
        return null;
    }
    if (row.ended_at || row.end_requested) {
        sendJson(res, 410, { error: 'This session has ended' });
        return null;
    }
    return { user, row };
}

function current(row) {
    const x = row.proxy_id ? pools.getProxyWithSecrets(row.proxy_id) : null;
    if (!x) return { direct: true, label: 'Direct (server IP)' };
    const score = pools.proxyScores([x.id]).get(x.id);
    return {
        id: x.id,
        label: sessionProxy.label(x),
        status: x.enabled ? x.status : 'disabled',
        latencyMs: x.latency_ms,
        score: score.score,
        exitIp: x.exit_ip,
        country: x.exit_country,
        countryCode: x.exit_country_code,
        city: x.exit_city,
        isp: x.exit_isp,
        checkedAt: x.exit_ip_checked_at
    };
}

function setupToolbarRoutes(proxyServer) {
    proxyServer.GET('/__portal/bar/state', (req, res) => {
        const sid = new URL(req.url, 'http://x').searchParams.get('sid');
        const ok = authorize(req, res, sid);
        if (!ok) return;
        const { user, row } = ok;
        const choices = sessionProxy.choices(user, row).map((pool) => ({
            name: pool.name,
            proxies: pool.proxies.map((x) => ({
                id: x.id,
                label: x.label,
                status: x.enabled ? x.status : 'disabled',
                usable: x.usable,
                current: x.current,
                latencyMs: x.latency_ms,
                score: x.score,
                exitIp: x.exit_ip,
                countryCode: x.exit_country_code,
                city: x.exit_city
            }))
        }));
        sendJson(res, 200, { current: current(row), pools: choices, engine: search.engine().name, portalUrl: config.appBaseUrl + '/' });
    });

    proxyServer.POST('/__portal/bar/go', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        try {
            const kind = search.classify(body.q);
            if (kind.type === 'empty') throw new Error('Type a web address or something to search for');
            const target = normalizeUrl(kind.type === 'search' ? kind.url : kind.input);
            if (kind.type === 'search') events.record('search', { userId: ok.user.id, detail: `${search.engine().name}: ${String(kind.query).slice(0, 200)} (toolbar)` });
            sendJson(res, 200, { location: `/${ok.row.id}/${target}` });
        } catch (e) {
            sendJson(res, 400, { error: e.message });
        }
    });

    proxyServer.POST('/__portal/bar/switch', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        try {
            const r = sessionProxy.change(ok.row, String(body.proxyId || ''), { user: ok.user });
            // Check the new proxy's exit IP right away so the toolbar can show it.
            const proxy = pools.getProxyWithSecrets(String(body.proxyId));
            const check = await require('../jobs/healthCheck').exitIp(proxy, { timeoutMs: 8000 });
            sendJson(res, 200, { ...r, check, current: current(sessions.get(ok.row.id)) });
        } catch (e) {
            sendJson(res, 400, { error: e.message });
        }
    });

    proxyServer.POST('/__portal/bar/check', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        const proxy = ok.row.proxy_id ? pools.getProxyWithSecrets(ok.row.proxy_id) : null;
        if (!proxy) return sendJson(res, 200, { check: { ok: false, error: 'This session connects directly' }, current: current(ok.row) });
        const check = await require('../jobs/healthCheck').exitIp(proxy, { timeoutMs: 8000 });
        if (!check.ok) log.warn('toolbar exit IP check failed', { proxy: sessionProxy.label(proxy), error: check.error });
        sendJson(res, 200, { check, current: current(sessions.get(ok.row.id)) });
    });

    proxyServer.POST('/__portal/bar/hide', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        users.setToolbar(ok.user.id, false);
        events.record('toolbar_disabled', { userId: ok.user.id, detail: 'hidden from a proxied page' });
        sendJson(res, 200, { ok: true });
    });
}

module.exports = { setupToolbarRoutes, barKey };
