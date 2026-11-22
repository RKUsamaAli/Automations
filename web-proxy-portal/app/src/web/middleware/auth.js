'use strict';
/**
 * Portal authentication middleware.
 *
 *   loadUser     - reads the pp_login cookie, sets req.user (or null)
 *   requireUser  - 401 for API calls / redirect to /login for pages
 *   requireAdmin - same, plus role check
 */
const users = require('../../services/users');
const { COOKIE_LOGIN, readLogin } = require('../../lib/authTokens');

function loadUser(req, _res, next) {
    req.user = null;
    const payload = readLogin(req.cookies[COOKIE_LOGIN]);
    if (payload) {
        const user = users.getByIdCached(payload.uid);
        // token_version mismatch = password changed / user disabled / "log out everywhere"
        if (user && user.enabled && user.token_version === payload.v) req.user = user;
    }
    next();
}

const isApi = (req) => req.originalUrl.startsWith('/api/');

function requireUser(req, res, next) {
    if (req.user) return next();
    if (isApi(req)) return res.status(401).json({ error: 'Not logged in' });
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    if (!req.user) return requireUser(req, res, next);
    if (isApi(req)) return res.status(403).json({ error: 'Admins only' });
    return res.redirect(302, '/');
}

module.exports = { loadUser, requireUser, requireAdmin };
