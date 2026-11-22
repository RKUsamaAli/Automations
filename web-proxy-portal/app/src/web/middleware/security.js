'use strict';
/**
 * Security middleware for the portal hostname.
 *
 *  - securityHeaders: strict CSP (portal pages only load their own files),
 *    no framing, no sniffing.
 *  - csrf: "double submit cookie". The browser JS reads the non-HttpOnly
 *    pp_csrf cookie and sends it back in the X-CSRF-Token header. A forged
 *    cross-site request cannot read the cookie, so it cannot set the header.
 */
const crypto = require('crypto');
const { COOKIE_CSRF, parseCookies, serializeCookie } = require('../../lib/authTokens');

function securityHeaders(req, res, next) {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
}

/** Attaches req.cookies (tiny replacement for cookie-parser). */
function cookies(req, _res, next) {
    req.cookies = parseCookies(req.headers.cookie);
    next();
}

/** Ensures a CSRF cookie exists; validates it on state-changing API calls. */
function csrf(req, res, next) {
    let token = req.cookies[COOKIE_CSRF];
    if (!token || token.length < 20) {
        token = crypto.randomBytes(24).toString('base64url');
        res.append('Set-Cookie', serializeCookie(COOKIE_CSRF, token, { httpOnly: false, sameSite: 'Strict' }));
        req.cookies[COOKIE_CSRF] = token;
    }
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (safe) return next();
    const sent = req.get('X-CSRF-Token') || '';
    const a = Buffer.from(sent);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Invalid CSRF token. Reload the page and try again.' });
    }
    next();
}

module.exports = { securityHeaders, cookies, csrf };
