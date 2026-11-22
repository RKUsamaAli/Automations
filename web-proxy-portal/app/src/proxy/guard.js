'use strict';
/**
 * The request guard. Runs FIRST for every request that reaches the proxy
 * engine (HTTP and WebSocket), before Rammerhead/hammerhead touch it.
 *
 *  1. Strip headers that would reveal the user's real IP to target sites
 *  2. Authenticate    - valid pp_proxy cookie for an enabled user
 *  3. Authorize       - the session in the URL belongs to that user and is active
 *  4. IP lock         - optional (setting restrict_session_to_ip)
 *  5. Upstream proxy  - point the session at its sticky upstream proxy
 *  6. Address checks  - private/internal addresses blocked; allowlist for
 *                       page navigations (or all requests in strict mode)
 *  7. Rate limit      - requests/minute and daily bandwidth per user
 *  8. Usage tracking  - counts response bytes; records the step in the session's
 *                       trail (pages + failures only) for error reports
 *  9. Dropped pages   - upstream hang-ups on page loads get an error page + report
 *
 * Return value contract (Rammerhead pipeline): `true` = we answered, stop.
 */
const config = require('../config');
const users = require('../services/users');
const sessions = require('../services/sessions');
const settings = require('../services/settings');
const sites = require('../services/sites');
const usage = require('../services/usage');
const events = require('../services/events');
const RateLimiter = require('../lib/rateLimiter');
const TtlCache = require('../lib/ttlCache');
const upstream = require('./upstream');
const { parseProxied } = require('./proxyUrl');
const { COOKIE_PROXY, parseCookies, readProxy } = require('../lib/authTokens');
const { renderMessage } = require('./pages');
const { isPrivateHost } = require('../lib/netGuard');
const observability = require('./observability');

// Paths anyone may open without the proxy cookie.
const PUBLIC_PATHS = new Set(['/__portal/start', '/__portal/logout', '/__portal/healthz', '/', '/favicon.ico', '/robots.txt']);

// Headers nginx / CDNs add. Removing them stops target sites seeing the user's real IP.
const STRIP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'true-client-ip', 'cdn-loop'];

const limiter = new RateLimiter(60000);
const blockedLogged = new TtlCache(60000); // avoid flooding the event log

/** Real client IP. Captured once (before the IP headers are stripped) and kept on req. */
function clientIp(req) {
    if (req.portalClientIp) return req.portalClientIp;
    if (config.trustProxy && req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
    return req.socket.remoteAddress;
}

/** Was this request a page/iframe navigation (vs. image, script, xhr ...)? */
function isNavigation(req, flags) {
    const dest = req.headers['sec-fetch-dest'];
    if (dest) return ['document', 'iframe', 'frame', 'embed', 'object'].includes(dest);
    if (/[if]/.test(flags || '')) return true; // hammerhead iframe / form markers
    return req.method === 'GET' && /text\/html/.test(req.headers.accept || '') && !/[sacw]/.test(flags || '');
}

/** Removes our own cookie before hammerhead parses the rest. */
function stripOwnCookie(req) {
    const c = req.headers.cookie;
    if (!c || !c.includes(COOKIE_PROXY + '=')) return;
    const rest = c
        .split(';')
        .filter((part) => part.trim().split('=')[0] !== COOKIE_PROXY)
        .join(';')
        .trim();
    if (rest) req.headers.cookie = rest;
    else delete req.headers.cookie;
}

/**
 * Sends an error. For websockets `res` is the raw socket.
 * Navigations get a friendly HTML page, everything else plain text.
 */
function deny(req, res, isWebsocket, status, message, { navigation = false, extraHeaders = {}, html = null } = {}) {
    if (isWebsocket) {
        try {
            res.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\n\r\n`);
        } catch (_) {
            /* socket already gone */
        }
        return true;
    }
    if (res.headersSent) {
        res.end();
        return true;
    }
    if (navigation) {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
        res.end(html || renderMessage({ title: 'Unavailable', message }));
    } else {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
        res.end(message);
    }
    return true;
}

/** Wraps res.write/end to count bytes sent to the browser, and records the step when it ends. */
function trackBytes(res, userId, sessionId, step) {
    let bytes = 0;
    const count = (chunk, encoding) => {
        if (!chunk || typeof chunk === 'function') return;
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    };
    const write = res.write;
    const end = res.end;
    res.write = function (chunk, encoding, cb) {
        count(chunk, encoding);
        return write.call(this, chunk, encoding, cb);
    };
    res.end = function (chunk, encoding, cb) {
        count(chunk, encoding);
        return end.call(this, chunk, encoding, cb);
    };
    let done = false;
    res.once('finish', () => {
        done = true;
        usage.track(userId, sessionId, bytes);
        observability.recordRequest({ ...step, res });
    });
    // Connection dropped before the response finished (upstream hung up, user navigated away ...)
    res.once('close', () => {
        if (!done) observability.recordRequest({ ...step, res, aborted: true });
    });
}

/**
 * @param {object} deps
 * @param {object} deps.rh           loaded rammerhead module
 * @param {object} deps.sessionStore RammerheadSessionFileCache
 */
function createGuard({ rh, sessionStore }) {
    const getSession = (id) => sessionStore.get(id, false);

    // Any exception in the checks below becomes an error report + an error page
    // with a reference, instead of a hung or reset connection.
    return async function guard(req, res, serverInfo, isRoute, isWebsocket) {
        try {
            return await checks(req, res, serverInfo, isRoute, isWebsocket);
        } catch (err) {
            observability.reportGuardException(req, res, err, isWebsocket);
            return true;
        }
    };

    async function checks(req, res, _serverInfo, isRoute, isWebsocket) {
        const startedAt = Date.now();
        req.portalClientIp = clientIp(req); // read X-Real-IP before it is removed
        req.portalRequestId = req.headers['x-request-id'] || null; // nginx's id, ties logs together
        delete req.headers['x-request-id']; // never forwarded to target sites
        for (const h of STRIP_HEADERS) delete req.headers[h];

        const pathname = (req.url || '').split('?')[0];
        if (isRoute && PUBLIC_PATHS.has(pathname)) return false;

        // ---- 2. authenticate ------------------------------------------------
        const cookies = parseCookies(req.headers.cookie);
        stripOwnCookie(req);
        const parsed = isRoute ? null : parseProxied(req.url, getSession, rh);
        const navigation = !isWebsocket && isNavigation(req, parsed && parsed.flags);
        const ip = req.portalClientIp;

        const auth = readProxy(cookies[COOKIE_PROXY]);
        const user = auth ? users.getForToken(auth.uid, auth.v) : null;
        if (!user || !user.enabled || user.pending || user.token_version !== auth.v) {
            if (navigation) {
                // Send them back through the portal login.
                res.writeHead(302, { Location: `${config.appBaseUrl}/login`, 'Cache-Control': 'no-store' });
                res.end();
                return true;
            }
            return deny(req, res, isWebsocket, 401, 'Not logged in');
        }
        req.portalUser = user;

        // Hammerhead/Rammerhead service routes (task.js, messaging, ...) only need a logged-in user.
        if (isRoute) return false;

        // ---- 3. session ownership --------------------------------------------
        const sid = rh.getSessionId(req.url) || rh.getSessionId(req.headers.referer);
        if (!sid) return deny(req, res, isWebsocket, 404, 'Not found', { navigation });
        const row = sessions.getCached(sid);
        if (!row || row.user_id !== user.id) {
            return deny(req, res, isWebsocket, 403, 'This browsing session does not belong to you.', { navigation });
        }
        if (row.ended_at || row.end_requested) {
            if (sessionStore.has(sid)) sessionStore.delete(sid);
            if (!row.ended_at) sessions.markEnded(sid, 'ended');
            return deny(req, res, isWebsocket, 410, 'This browsing session has ended. Start a new one from the portal.', {
                navigation,
                html: renderMessage({ title: 'Session ended', message: 'This browsing session has ended.', linkText: 'Back to portal', linkHref: config.appBaseUrl })
            });
        }
        const session = sessionStore.get(sid);
        if (!session) {
            sessions.markEnded(sid, 'expired');
            return deny(req, res, isWebsocket, 410, 'This browsing session expired.', {
                navigation,
                html: renderMessage({ title: 'Session expired', message: 'This browsing session expired after being idle.', linkText: 'Back to portal', linkHref: config.appBaseUrl })
            });
        }

        const s = settings.getAll();

        // ---- 4. optional IP lock ---------------------------------------------
        if (s.restrict_session_to_ip && session.data.restrictIP && session.data.restrictIP !== ip) {
            return deny(req, res, isWebsocket, 403, 'This session is locked to another network. Start a new session.', { navigation });
        }

        // ---- 5. sticky upstream proxy ---------------------------------------
        const up = await upstream.applyToSession(session, row);
        if (!up.ok) return deny(req, res, isWebsocket, 503, up.error, { navigation });

        // ---- 6a. never proxy to private/internal addresses (SSRF) -------------
        if (parsed && isPrivateHost(parsed.host)) {
            return deny(req, res, isWebsocket, 403, 'This address is not allowed.', { navigation });
        }

        // ---- 6b. domain allowlist --------------------------------------------
        if (s.allowlist_enabled && parsed && (navigation || s.allowlist_strict) && !sites.isHostAllowed(parsed.host)) {
            const key = `${user.id}|${parsed.host}`;
            if (!blockedLogged.get(key)) {
                blockedLogged.set(key, true);
                events.record('blocked_domain', { userId: user.id, detail: parsed.host, ip });
            }
            return deny(req, res, isWebsocket, 403, `${parsed.host} is not on the list of allowed sites.`, {
                navigation,
                html: renderMessage({ title: 'Site not allowed', message: `${parsed.host} is not on the list of allowed sites.`, linkText: 'Back to portal', linkHref: config.appBaseUrl })
            });
        }

        // ---- 7. rate limits ---------------------------------------------------
        const rpm = user.rate_limit_rpm ?? s.rate_limit_rpm;
        if (!limiter.hit(`u:${user.id}`, rpm)) {
            const retry = limiter.retryAfter(`u:${user.id}`);
            if (!blockedLogged.get(`rl|${user.id}`)) {
                blockedLogged.set(`rl|${user.id}`, true);
                events.record('rate_limited', { userId: user.id, detail: `${rpm} req/min`, ip });
            }
            return deny(req, res, isWebsocket, 429, 'Too many requests, slow down.', { navigation, extraHeaders: { 'Retry-After': String(retry) } });
        }
        const capMb = user.bandwidth_limit_mb_day ?? s.bandwidth_limit_mb_day;
        if (capMb && usage.bytesToday(user.id) > capMb * 1024 * 1024) {
            return deny(req, res, isWebsocket, 429, `Daily bandwidth limit (${capMb} MB) reached. It resets at 00:00 UTC.`, { navigation });
        }

        // ---- 8. usage tracking -----------------------------------------------
        if (!isWebsocket) trackBytes(res, user.id, sid, { sid, req, parsed, navigation, startedAt, userId: user.id });

        // ---- 9. dropped connections on page loads ------------------------------
        // When the upstream proxy / site hangs up, hammerhead just closes the
        // browser's connection (blank "connection closed" screen, nothing logged).
        // For page navigations we answer with our error page + report instead.
        if (navigation && parsed && typeof session.handlePageError === 'function') {
            const socket = req.socket;
            const originalEnd = socket.end;
            let restored = false;
            const restore = () => {
                if (!restored) {
                    restored = true;
                    socket.end = originalEnd;
                }
            };
            socket.end = function (...args) {
                if (!restored && !res.headersSent && !res.writableEnded) {
                    restore();
                    session.handlePageError(
                        { req, res, dest: { url: parsed.destUrl, hostname: parsed.host } },
                        Object.assign(new Error('socket hang up: the upstream proxy or the website closed the connection'), { code: 'ECONNRESET' })
                    );
                    return socket;
                }
                restore();
                return originalEnd.apply(this, args);
            };
            res.once('finish', restore);
            res.once('close', restore);
        }
        return false; // continue into Rammerhead
    }
}

// Note: WebSockets need no separate hook - hammerhead re-enters this same
// pipeline for upgrade requests with isWebsocket = true.
module.exports = { createGuard, isNavigation, stripOwnCookie, clientIp, PUBLIC_PATHS };
