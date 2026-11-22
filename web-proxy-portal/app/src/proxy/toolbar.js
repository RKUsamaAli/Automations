'use strict';
/**
 * Top bar on proxied pages - server side (proxy hostname).
 *
 *   GET  /__portal/bar/state?sid=     current proxy, exit IP + location, other proxies, page
 *   POST /__portal/bar/go     {sid,q}        address or search words -> proxied URL in this session
 *   POST /__portal/bar/switch {sid,proxyId}  move the session to another proxy + check its exit IP
 *   POST /__portal/bar/check  {sid}          re-check the current proxy's exit IP / speed
 *   POST /__portal/bar/hide   {sid}          turn the toolbar off for this user (Account page turns it on)
 *   GET  /__portal/results?sid=&q=           Google results (server browser, through the session's
 *                                            proxy) as a page inside the session, top bar included
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
const webSearch = require('../services/webSearch');
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

const healthCheck = () => require('../jobs/healthCheck');

/** The session's connection as the top bar shows it (incl. the exit time zone for the clock). */
async function current(row) {
    const x = row.proxy_id ? pools.getProxyWithSecrets(row.proxy_id) : null;
    if (!x) {
        const d = await healthCheck().directExit();
        return { direct: true, label: sessionProxy.label(null), exitIp: d.ip, country: d.country, countryCode: d.countryCode, city: d.city, isp: d.isp, timeZone: d.timeZone };
    }
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
        timeZone: x.exit_timezone,
        checkedAt: x.exit_ip_checked_at
    };
}

const RateLimiter = require('../lib/rateLimiter');
const searchLimiter = new RateLimiter(60000);

const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resultsPage({ q, sid, r, error, toolbar }) {
    const items = (r && r.results) || [];
    const list = items
        .map((x) => {
            let href;
            try {
                href = `/${sid}/${normalizeUrl(x.url)}`;
            } catch (_) {
                return '';
            }
            return `<div class="r"><div class="site">${escHtml(x.displayUrl || x.url)}</div><a class="title" href="${escHtml(href)}">${escHtml(x.title)}</a>${x.snippet ? `<div class="snip">${escHtml(x.snippet)}</div>` : ''}</div>`;
        })
        .join('');
    const meta = r ? `${items.length} results from ${r.engine === 'google' ? 'Google' : 'DuckDuckGo'}${r.cached ? ' (cached)' : ''}` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escHtml(q)} - Search</title><style>
:root{color-scheme:light dark}body{margin:0;font:15px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;background:#fff;color:#1b1f24}
main{max-width:720px;margin:0 auto;padding:18px 16px 40px}.meta{color:#6b7380;font-size:13px;margin:4px 0 14px}
.r{padding:10px 0}.site{color:#3c4a5c;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title{font-size:19px;color:#1a0dab;text-decoration:none;display:inline-block;margin:2px 0}
.title:hover{text-decoration:underline}.snip{color:#4d5562;font-size:14px}.note{padding:10px 12px;border-radius:10px;background:#eef2ff;color:#28396b;font-size:13px;margin-bottom:12px}
.err{padding:10px 12px;border-radius:10px;background:#fde4e4;color:#a32020}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e7eaee}.title{color:#8ab4f8}.site,.meta,.snip{color:#9aa5b3}.note{background:#26304a;color:#c9d6ff}.err{background:#3d1717;color:#ff8a8a}}
</style></head><body><main id="results">
${r ? `<div class="meta" id="results-meta">${escHtml(meta)}</div>` : ''}${r && r.note ? `<div class="note">${escHtml(r.note)}</div>` : ''}${error ? `<div class="err" role="alert">${escHtml(error)}</div>` : ''}
${r && !items.length ? '<p>No results. Try other words.</p>' : list}
</main><script>${toolbar}</script></body></html>`;
}

function setupToolbarRoutes(proxyServer) {
    // Results page for words typed in the top bar. A top-level page load only
    // (it carries the bar's key, so fetch() from a website must not read it).
    proxyServer.GET('/__portal/results', async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const sid = url.searchParams.get('sid');
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 300);
        const user = req.portalUser;
        const row = sid ? sessions.get(String(sid)) : null;
        const dest = req.headers['sec-fetch-dest'];
        const html = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
            res.end(body);
        };
        if (!user || !row || row.user_id !== user.id || (dest && dest !== 'document') || row.ended_at || row.end_requested) {
            return html(403, '<!doctype html><title>Not allowed</title><p>Not allowed. <a href="' + escHtml(config.appBaseUrl) + '/">Back to the portal</a></p>');
        }
        if (!q) {
            res.writeHead(302, { Location: config.appBaseUrl + '/' });
            return res.end();
        }
        const toolbar = require('./toolbarClient').toolbarScript(
            { sid: row.id, key: barKey(row.id), base: config.proxyBaseUrl, portalUrl: config.appBaseUrl + '/', shadow: process.env.TOOLBAR_SHADOW === 'open' ? 'open' : 'closed' },
            { url: null, host: null, query: q }
        ).replace(/<\/script/gi, '<\\/script');
        if (!searchLimiter.hit(`s:${user.id}`, 20)) return html(429, resultsPage({ q, sid: row.id, r: null, error: 'Too many searches. Wait a minute and try again.', toolbar }));
        const proxy = row.proxy_id ? pools.getProxyWithSecrets(row.proxy_id) : null;
        const lang = String(req.headers['accept-language'] || 'en').split(/[,;-]/)[0].toLowerCase().replace(/[^a-z]/g, '').slice(0, 5) || 'en';
        try {
            const r = await webSearch.search({ q, proxy, lang });
            events.record('search', { userId: user.id, detail: `${r.engine}: ${q.slice(0, 200)} (top bar, ${r.results.length} results)` });
            html(200, resultsPage({ q, sid: row.id, r, toolbar }));
        } catch (e) {
            log.warn('top bar search failed', { error: e.message });
            html(e.status === 503 ? 503 : 502, resultsPage({ q, sid: row.id, r: null, error: e.message, toolbar }));
        }
    });

    proxyServer.GET('/__portal/bar/state', async (req, res) => {
        const sid = new URL(req.url, 'http://x').searchParams.get('sid');
        const ok = authorize(req, res, sid);
        if (!ok) return;
        const { user, row } = ok;
        const choices = sessionProxy.choices(user, row).map((pool) => ({
            name: pool.name,
            proxies: pool.proxies.map((x) => ({
                id: x.id,
                direct: !!x.direct,
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
        sendJson(res, 200, { current: await current(row), pools: choices, engine: search.engine().name, portalUrl: config.appBaseUrl + '/' });
    });

    proxyServer.POST('/__portal/bar/go', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        try {
            const kind = search.classify(body.q);
            if (kind.type === 'empty') throw new Error('Type a web address or something to search for');
            if (kind.type === 'search' && webSearch.useServerGoogle()) {
                return sendJson(res, 200, { location: `/__portal/results?sid=${encodeURIComponent(ok.row.id)}&q=${encodeURIComponent(kind.query)}` });
            }
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
            // Check the new proxy's exit IP right away so the bar can show it ("No proxy": nothing to check).
            const proxy = body.proxyId === sessionProxy.DIRECT ? null : pools.getProxyWithSecrets(String(body.proxyId));
            const check = proxy ? await healthCheck().exitIp(proxy, { timeoutMs: 8000 }) : null;
            sendJson(res, 200, { ...r, check, current: await current(sessions.get(ok.row.id)) });
        } catch (e) {
            sendJson(res, 400, { error: e.message });
        }
    });

    proxyServer.POST('/__portal/bar/check', async (req, res) => {
        const body = await readJson(req);
        const ok = authorize(req, res, body.sid);
        if (!ok) return;
        const proxy = ok.row.proxy_id ? pools.getProxyWithSecrets(ok.row.proxy_id) : null;
        if (!proxy) return sendJson(res, 200, { check: { ok: true }, current: await current(ok.row) });
        const check = await healthCheck().exitIp(proxy, { timeoutMs: 8000 });
        if (!check.ok) log.warn('toolbar exit IP check failed', { proxy: sessionProxy.label(proxy), error: check.error });
        sendJson(res, 200, { check, current: await current(sessions.get(ok.row.id)) });
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
