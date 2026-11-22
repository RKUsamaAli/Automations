'use strict';
/**
 * Cookies and tickets that connect the two hostnames.
 *
 *   PORTAL (portal.example.com)                PROXY (browse.example.com)
 *   ---------------------------                --------------------------
 *   pp_login cookie (host-only)                pp_proxy cookie (host-only)
 *          |                                          ^
 *          |  POST /api/browse  -> signed TICKET      |
 *          +----> browser redirect --> /__portal/start?t=TICKET
 *                                      (validates ticket, creates session,
 *                                       sets pp_proxy, redirects to /<sid>/<url>)
 *
 * Because each cookie is host-only, a proxied website (running on the proxy
 * hostname) can never see or use the portal/admin login.
 */
const crypto = require('crypto');
const config = require('../config');
const { sign, verify } = require('./crypto');

const COOKIE_LOGIN = 'pp_login';
const COOKIE_CSRF = 'pp_csrf';
const COOKIE_PROXY = 'pp_proxy';
const TICKET_TTL_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------- login ----
function mintLogin(user) {
    const exp = Date.now() + config.session.loginTtlHours * 3600000;
    return { token: sign({ uid: user.id, v: user.token_version, exp }, config.appSecret, 'login'), exp };
}
const readLogin = (token) => verify(token, config.appSecret, 'login');

// ---------------------------------------------------------------- proxy ----
function mintProxy(user) {
    const exp = Date.now() + config.session.loginTtlHours * 3600000;
    return { token: sign({ uid: user.id, v: user.token_version, exp }, config.appSecret, 'proxy'), exp };
}
const readProxy = (token) => verify(token, config.appSecret, 'proxy');

// --------------------------------------------------------------- ticket ----
/**
 * @param {object} p
 * @param {number} p.uid
 * @param {number} p.v       token_version
 * @param {string} [p.url]   start URL (new session)
 * @param {string} [p.sid]   existing session to resume
 * @param {number} [p.pool]  proxy pool the user picked (validated by the portal)
 */
function mintTicket({ uid, v, url = null, sid = null, pool = null, cid = null }) {
    return sign(
        { uid, v, url, sid, pool, cid, n: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + TICKET_TTL_MS },
        config.appSecret,
        'ticket'
    );
}
const readTicket = (token) => verify(token, config.appSecret, 'ticket');

// -------------------------------------------------------------- cookies ----
/** Parses a Cookie header into an object (first value wins). */
function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim();
        if (k in out) continue;
        let v = part.slice(i + 1).trim();
        try {
            v = decodeURIComponent(v);
        } catch (_) {
            /* keep raw */
        }
        out[k] = v;
    }
    return out;
}

/** Serializes a Set-Cookie value. Secure is added whenever we serve https. */
function serializeCookie(name, value, { maxAgeSec, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
    if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
    if (httpOnly) parts.push('HttpOnly');
    if (config.publicProtocol === 'https') parts.push('Secure');
    return parts.join('; ');
}

module.exports = {
    COOKIE_LOGIN,
    COOKIE_CSRF,
    COOKIE_PROXY,
    TICKET_TTL_MS,
    mintLogin,
    readLogin,
    mintProxy,
    readProxy,
    mintTicket,
    readTicket,
    parseCookies,
    serializeCookie
};
