'use strict';
/**
 * Sign-in tokens, cookies and the tickets that connect the two hostnames.
 *
 * PORTAL hostname (portal.example.com) - two JWTs, both httpOnly cookies:
 *   pp_id  IDENTITY token  IDENTITY_TOKEN_TTL_HOURS (default 24 h)
 *          "who you are". Only used to obtain access tokens
 *          (POST /api/auth/refresh). When it expires the user re-enters the
 *          password in an overlay and continues where they were.
 *   pp_at  ACCESS token    ACCESS_TOKEN_TTL_MINUTES (default 5 min)
 *          sent with every request; carries what requests need (claims below),
 *          renewed silently by the browser from the identity token.
 *
 * PROXY hostname (browse.example.com):
 *   pp_proxy  PROXY token (JWT, audience = proxy URL), valid until the identity
 *          token expires. Set by /__portal/start from a one-time TICKET.
 *
 *   portal: POST /api/portal/browse -> signed TICKET (2 min, single use)
 *     -> browser redirect -> proxy /__portal/start?t=TICKET -> pp_proxy cookie
 *
 * Revocation: every token carries `tv` (users.token_version). Password change,
 * disabling a user or "sign out everywhere" bumps it, and the server compares
 * it with a 3-second cache of the user row, so revocation is near-instant
 * even though tokens are self-contained.
 *
 * All cookies are host-only, so a proxied website (running on the proxy
 * hostname) can never see or use the portal/admin sign-in.
 */
const crypto = require('crypto');
const config = require('../config');
const { sign, verify } = require('./crypto');
const jwt = require('./jwt');

const COOKIE_IDENTITY = 'pp_id';
const COOKIE_ACCESS = 'pp_at';
const COOKIE_CSRF = 'pp_csrf';
const COOKIE_PROXY = 'pp_proxy';
const TICKET_TTL_MS = 2 * 60 * 1000;

// ------------------------------------------------------- identity token ----
/**
 * @param {object} user  users row
 * @param {object} o     { method: 'password'|'access_code', authTime }
 */
function issueIdentity(user, { method = 'password', authTime } = {}) {
    return jwt.sign(
        { sub: user.id, name: user.username, tv: user.token_version, amr: [method === 'access_code' ? 'otp' : 'pwd'], auth_time: authTime || Math.floor(Date.now() / 1000) },
        { kind: 'identity', ttlSec: config.session.identityTtlHours * 3600 }
    );
}
const readIdentity = (token) => jwt.inspect(token, { kind: 'identity' });

// --------------------------------------------------------- access token ----
/**
 * Everything a request needs to know about the caller, so most requests do
 * not have to look the user up:
 *   sub   user id (GUID)          name  username        email
 *   role  'admin' | 'user'        pool  assigned proxy pool id (or null)
 *   rpm   requests/minute limit   bw    traffic MB/day limit (null = default)
 *   tz    browser time zone       tv    token version (revocation)
 *   sid   id of the identity token (= sign-in session) it was issued from
 *   idx   identity token expiry (seconds) - the browser shows the re-sign-in
 *         prompt at that moment
 */
function issueAccess(user, identityClaims) {
    const idExp = identityClaims.exp;
    const ttl = Math.max(1, Math.min(config.session.accessTtlMinutes * 60, idExp - Math.floor(Date.now() / 1000)));
    return jwt.sign(
        {
            sub: user.id,
            name: user.username,
            email: user.email || null,
            role: user.role,
            pool: user.pool_id || null,
            rpm: user.rate_limit_rpm ?? null,
            bw: user.bandwidth_limit_mb_day ?? null,
            tz: user.timezone || null,
            tv: user.token_version,
            sid: identityClaims.jti,
            idx: idExp
        },
        { kind: 'access', ttlSec: ttl }
    );
}
const readAccess = (token) => jwt.inspect(token, { kind: 'access' });

// ---------------------------------------------------------- proxy token ----
/** Proxy hostname sign-in, valid as long as the portal identity token. */
function issueProxy(user, untilSec) {
    const ttl = Math.max(60, (untilSec || Math.floor(Date.now() / 1000) + config.session.identityTtlHours * 3600) - Math.floor(Date.now() / 1000));
    return jwt.sign({ sub: user.id, name: user.username, role: user.role, tv: user.token_version }, { kind: 'proxy', ttlSec: ttl, audience: config.proxyBaseUrl });
}
/** -> { uid, v, claims } or null (shape kept for the proxy guard). */
function readProxy(token) {
    const c = jwt.verify(token, { kind: 'proxy', audience: config.proxyBaseUrl });
    return c ? { uid: c.sub, v: c.tv, claims: c } : null;
}

// --------------------------------------------------------------- ticket ----
/**
 * @param {object} p
 * @param {string} p.uid
 * @param {number} p.v       token_version
 * @param {string} [p.url]   start URL (new session)
 * @param {string} [p.sid]   existing session to resume
 * @param {number} [p.pool]  proxy pool the user picked (validated by the portal)
 */
function mintTicket({ uid, v, url = null, sid = null, pool = null, cid = null, until = null }) {
    return sign(
        // until = identity token expiry (s): the proxy sign-in ends with it
        { uid, v, url, sid, pool, cid, until, n: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + TICKET_TTL_MS },
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
    COOKIE_IDENTITY,
    COOKIE_ACCESS,
    COOKIE_CSRF,
    COOKIE_PROXY,
    TICKET_TTL_MS,
    issueIdentity,
    readIdentity,
    issueAccess,
    readAccess,
    issueProxy,
    readProxy,
    mintTicket,
    readTicket,
    parseCookies,
    serializeCookie
};
