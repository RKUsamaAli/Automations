'use strict';
/**
 * Portal authentication middleware (JWT identity + access tokens, see
 * lib/authTokens.js).
 *
 *   loadUser     - sets req.user (full user row) and req.token (access claims)
 *                  from the pp_at access token. When it is missing/expired:
 *                    * page navigations: a new access token is issued silently
 *                      from the pp_id identity token (a page load cannot run
 *                      the refresh script first);
 *                    * API calls: answered 401 code=access_token_expired by
 *                      requireUser - the browser calls /api/auth/refresh and
 *                      retries (common.js).
 *                  req.auth.state: ok | access_expired | identity_expired | none
 *   requireUser  - 401 for API calls / redirect to /login for pages
 *   requireAdmin - same, plus role check
 *   setSignInCookies(res, user, identityClaims) - shared by login / refresh
 */
const users = require('../../services/users');
const {
    COOKIE_ACCESS,
    COOKIE_IDENTITY,
    readAccess,
    readIdentity,
    issueAccess,
    serializeCookie
} = require('../../lib/authTokens');

/** A user row may act only if it exists, is enabled/approved and the token version matches. */
function usable(user, tv) {
    return !!(user && user.enabled && !user.pending && user.token_version === tv);
}

/** Sets a fresh access cookie; returns its claims. */
function setAccessCookie(res, user, identityClaims) {
    const { token, claims } = issueAccess(user, identityClaims);
    res.append('Set-Cookie', serializeCookie(COOKIE_ACCESS, token, { maxAgeSec: claims.exp - Math.floor(Date.now() / 1000) }));
    return claims;
}

/** Identity + access cookies after a successful sign-in. */
function setSignInCookies(res, user, identity) {
    res.append('Set-Cookie', serializeCookie(COOKIE_IDENTITY, identity.token, { maxAgeSec: identity.claims.exp - Math.floor(Date.now() / 1000) }));
    return setAccessCookie(res, user, identity.claims);
}

function clearSignInCookies(res) {
    res.append('Set-Cookie', serializeCookie(COOKIE_IDENTITY, '', { maxAgeSec: 0 }));
    res.append('Set-Cookie', serializeCookie(COOKIE_ACCESS, '', { maxAgeSec: 0 }));
}

const isApi = (req) => req.originalUrl.startsWith('/api/');

function loadUser(req, res, next) {
    req.user = null;
    req.token = null;
    req.auth = { state: 'none' };

    // 1. access token (normal case: no database work beyond the 3 s user cache)
    const access = readAccess(req.cookies[COOKIE_ACCESS]);
    if (access && !access.expired) {
        const user = users.getForToken(access.claims.sub, access.claims.tv);
        if (usable(user, access.claims.tv)) {
            req.user = user;
            req.token = access.claims;
            req.auth = { state: 'ok' };
            return next();
        }
        // revoked (password changed, disabled, signed out everywhere) -> treat as signed out
    }

    // 2. no valid access token: look at the identity token
    const identity = readIdentity(req.cookies[COOKIE_IDENTITY]);
    if (!identity) return next();
    const user = users.getForToken(identity.claims.sub, identity.claims.tv);
    if (!usable(user, identity.claims.tv)) return next();
    if (identity.expired) {
        req.auth = { state: 'identity_expired', username: user.username, method: (identity.claims.amr || [])[0] === 'otp' ? 'access_code' : 'password' };
        return next();
    }
    if (!isApi(req) && req.method === 'GET') {
        // page navigation: renew silently
        req.token = setAccessCookie(res, user, identity.claims);
        req.user = user;
        req.auth = { state: 'ok' };
        return next();
    }
    req.auth = { state: 'access_expired' };
    next();
}

/** 401 body for API calls, telling the browser what to do next. */
function unauthorized(req, res) {
    const s = req.auth || { state: 'none' };
    if (s.state === 'access_expired') return res.status(401).json({ error: 'Access token expired', code: 'access_token_expired' });
    if (s.state === 'identity_expired') return res.status(401).json({ error: 'Your sign-in has expired', code: 'identity_expired', username: s.username, method: s.method });
    return res.status(401).json({ error: 'Not logged in', code: 'not_signed_in' });
}

function requireUser(req, res, next) {
    if (req.user) return next();
    if (isApi(req)) return unauthorized(req, res);
    const expired = req.auth && req.auth.state === 'identity_expired' ? '&expired=1' : '';
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl) + expired);
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    if (!req.user) return requireUser(req, res, next);
    if (isApi(req)) return res.status(403).json({ error: 'Admins only' });
    return res.redirect(302, '/');
}

module.exports = { loadUser, requireUser, requireAdmin, unauthorized, setSignInCookies, setAccessCookie, clearSignInCookies, usable };
