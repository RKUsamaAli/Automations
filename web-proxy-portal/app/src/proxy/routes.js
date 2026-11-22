'use strict';
/**
 * Extra routes added to the Rammerhead server (PROXY_DOMAIN).
 *
 *   GET /__portal/start?t=<ticket>  hand-off from the portal: validates the
 *                                   ticket, creates/resumes the session, sets
 *                                   the pp_proxy cookie, redirects into the site
 *   GET /__portal/logout            clears the proxy cookie, then back to the portal sign-in
 *   GET /__portal/inject.js         custom scripts bundle for the current page
 *   GET /__portal/healthz           health probe for deploy.sh
 *   GET /                           redirect to the portal
 *   GET /robots.txt                 keep search engines out of the proxy
 */
const config = require('../config');
const db = require('../db');
const users = require('../services/users');
const clientDevices = require('../services/clientDevices');
const sessions = require('../services/sessions');
const sites = require('../services/sites');
const settings = require('../services/settings');
const scripts = require('../services/scripts');
const events = require('../services/events');
const upstream = require('./upstream');
const { parseProxied } = require('./proxyUrl');
const { clientIp } = require('./guard');
const { renderMessage } = require('./pages');
const { COOKIE_PROXY, TICKET_TTL_MS, readTicket, issueProxy, serializeCookie } = require('../lib/authTokens');
const { describeProxy } = require('../lib/proxyString');
const { setupToolbarRoutes, barKey } = require('./toolbar');
const log = require('../lib/logger')('proxy-routes');

const INJECT_PATH = '/__portal/inject.js';

function sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
}

const backToPortal = (title, message) =>
    renderMessage({ title, message, linkText: 'Back to portal', linkHref: config.appBaseUrl });

/** Marks a ticket nonce as used. Returns false if it was already used (replay). */
function consumeNonce(nonce) {
    try {
        db.insert('used_tickets', { nonce, expires_at: Date.now() + TICKET_TTL_MS });
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * @param {object} deps
 * @param {object} deps.proxyServer  RammerheadProxy
 * @param {object} deps.sessionStore RammerheadSessionFileCache
 * @param {object} deps.rh           loaded rammerhead module
 */
function setupRoutes({ proxyServer, sessionStore, rh }) {
    // ------------------------------------------------------------ start ----
    proxyServer.GET('/__portal/start', (req, res) => {
        const url = new URL(req.url, 'http://x');
        const ticket = readTicket(url.searchParams.get('t'));
        if (!ticket) return sendHtml(res, 400, backToPortal('Link expired', 'This link has expired. Please start again from the portal.'));
        if (!consumeNonce(ticket.n)) return sendHtml(res, 400, backToPortal('Link already used', 'This link was already used. Please start again from the portal.'));

        const user = users.getById(ticket.uid);
        if (!user || !user.enabled || user.pending || user.token_version !== ticket.v) {
            return sendHtml(res, 403, backToPortal('Not allowed', 'Your account is not active. Please log in again.'));
        }
        const ip = clientIp(req);
        let sid;
        let target;

        if (ticket.sid) {
            // ---- resume an existing session ----
            const row = sessions.get(ticket.sid);
            if (!row || row.user_id !== user.id || row.ended_at || row.end_requested) {
                return sendHtml(res, 410, backToPortal('Session ended', 'That session has ended. Start a new one.'));
            }
            if (!sessionStore.has(row.id)) {
                sessions.markEnded(row.id, 'expired');
                return sendHtml(res, 410, backToPortal('Session expired', 'That session expired after being idle. Start a new one.'));
            }
            sid = row.id;
            target = ticket.url || row.start_url;
        } else {
            // ---- create a new session ----
            target = ticket.url;
            const choice = upstream.chooseForNewSession(user, target, sites.listEnabled(), ticket.pool);
            if (choice.error) {
                events.record('session_refused', { userId: user.id, detail: choice.error, ip });
                return sendHtml(res, 503, backToPortal('No proxy available', choice.error));
            }
            sid = rh.generateId();
            const session = new rh.RammerheadSession();
            if (settings.get('restrict_session_to_ip')) session.data.restrictIP = ip;
            session.data.portalUserId = user.id;
            ensureInjector(session);
            sessionStore.addSerializedSession(sid, session.serializeSession());
            sessions.create({
                id: sid,
                userId: user.id,
                poolId: choice.poolId,
                proxyId: choice.proxy ? choice.proxy.id : null,
                startUrl: target,
                clientIp: ip,
                userAgent: req.headers['user-agent'],
                clientId: ticket.cid || clientDevices.fromRequest(req)
            });
            events.record('session_start', {
                userId: user.id,
                detail: `${new URL(target).hostname} via ${choice.proxy ? describeProxy(choice.proxy) : 'direct'}`,
                ip
            });
        }

        // Proxy sign-in (JWT) lasts as long as the portal identity token it came from.
        const { token, claims } = issueProxy(user, ticket.until);
        res.writeHead(302, {
            'Set-Cookie': serializeCookie(COOKIE_PROXY, token, { maxAgeSec: claims.exp - Math.floor(Date.now() / 1000) }),
            Location: `/${sid}/${target}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer'
        });
        res.end();
    });

    // ----------------------------------------------------------- logout ----
    // The portal's sign-out sends the browser here so the proxy cookie (which
    // lives on this hostname) is removed too. Always returns to the portal.
    proxyServer.GET('/__portal/logout', (_req, res) => {
        res.writeHead(302, {
            'Set-Cookie': serializeCookie(COOKIE_PROXY, '', { maxAgeSec: 0 }),
            Location: `${config.appBaseUrl}/login?signedout=1`,
            'Cache-Control': 'no-store'
        });
        res.end();
    });

    // ----------------------------------------------------------- inject ----
    proxyServer.GET(INJECT_PATH, (req, res) => {
        // The script tag is requested BY the proxied page, so the Referer is
        // that page's proxy URL - decode it to find the real site.
        const page = parseProxied(req.headers.referer, (id) => sessionStore.get(id, false), rh);
        // The toolbar (with its per-session key) only goes to real <script> loads
        // of this session's own pages - never to fetch()/XHR, so a website cannot
        // read the key by requesting this file itself.
        const dest = req.headers['sec-fetch-dest'];
        const user = req.portalUser;
        const row = page && page.sid ? sessions.getCached(page.sid) : null;
        const toolbarOn = settings.get('show_portal_button') && user && user.toolbar_enabled !== 0;
        const toolbar =
            toolbarOn && row && row.user_id === user.id && (!dest || dest === 'script')
                ? { sid: row.id, key: barKey(row.id), base: config.proxyBaseUrl, portalUrl: config.appBaseUrl + '/', shadow: process.env.TOOLBAR_SHADOW === 'open' ? 'open' : 'closed' }
                : null;
        let body;
        try {
            body = scripts.buildBundle(page ? page.destUrl : null, page ? page.host : null, undefined, {
                portalUrl: toolbarOn && !toolbar ? config.appBaseUrl + '/' : null,
                toolbar
            });
        } catch (e) {
            log.error('failed to build script bundle', e);
            body = '/* portal: script bundle error */';
        }
        res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(body);
    });

    setupToolbarRoutes(proxyServer);

    // ----------------------------------------------------------- health ----
    proxyServer.GET('/__portal/healthz', (_req, res) => {
        let ok = true;
        try {
            db.get().prepare('SELECT 1').get();
        } catch (_) {
            ok = false;
        }
        res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok, service: 'proxy', release: config.releaseName, pid: process.pid }));
    });

    // ------------------------------------------------------------- misc ----
    proxyServer.GET('/', (_req, res) => {
        res.writeHead(302, { Location: config.appBaseUrl + '/' });
        res.end();
    });
    proxyServer.GET('/robots.txt', { content: Buffer.from('User-agent: *\nDisallow: /\n'), contentType: 'text/plain' });
    proxyServer.GET('/favicon.ico', (_req, res) => {
        res.writeHead(204);
        res.end();
    });
}

/**
 * Adds the custom-script loader to a session's injected scripts (once).
 * Hammerhead then adds <script src="/__portal/inject.js"> to every HTML page.
 */
function ensureInjector(session) {
    const list = session.injectable && session.injectable.scripts;
    if (Array.isArray(list) && !list.includes(INJECT_PATH)) list.push(INJECT_PATH);
}

module.exports = { setupRoutes, ensureInjector, INJECT_PATH };
