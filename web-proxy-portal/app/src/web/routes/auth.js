'use strict';
/**
 * Authentication API.
 *
 *   POST /api/auth/register  { username, email?, password }     self sign-up (setting registration_mode)
 *   POST /api/auth/login     { username, password } | { token }  [, continueAs: userId ]
 *                            -> identity (pp_id) + access (pp_at) JWT cookies
 *   POST /api/auth/refresh   new 5-min access token from the identity token
 *                            -> 401 code=identity_expired when the identity token
 *                               expired: the page shows the password prompt
 *   POST /api/auth/logout    { everywhere? }
 *   GET  /api/auth/me        current user, token expiry times + public portal settings
 *   POST /api/auth/password  { currentPassword, newPassword }    change own password
 */
const express = require('express');
const users = require('../../services/users');
const events = require('../../services/events');
const settings = require('../../services/settings');
const sessions = require('../../services/sessions');
const config = require('../../config');
const RateLimiter = require('../../lib/rateLimiter');
const { COOKIE_IDENTITY, issueIdentity, readIdentity } = require('../../lib/authTokens');
const { setSignInCookies, setAccessCookie, clearSignInCookies, unauthorized, usable } = require('../middleware/auth');
const context = require('../../lib/context');

const router = express.Router();

// Brute-force protection: 10 failed attempts per 15 min per IP (nginx adds another layer).
const failures = new RateLimiter(15 * 60000);
const MAX_FAILURES = 10;
// Sign-up spam protection: SIGNUP_LIMIT_PER_HOUR (default 5) registrations per hour per IP.
const signups = new RateLimiter(60 * 60000);

const LOGIN_ERRORS = {
    invalid: 'Invalid username or password',
    pending: 'Your account is waiting for an administrator to approve it.',
    disabled: 'Your account has been disabled. Contact the administrator.'
};

// Refresh calls per identity token per minute (a page refreshes about every 5 min).
const refreshes = new RateLimiter(60000);

/** Issues identity + access cookies. Returns the session info the browser keeps. */
function signIn(res, user, method) {
    const identity = issueIdentity(user, { method });
    const access = setSignInCookies(res, user, identity);
    context.setActor(user.id); // the rest of this request acts as the signed-in user
    return sessionInfo(access, method);
}
/** Expiry times (ms) the browser uses to renew silently / show the password prompt in time. */
function sessionInfo(access, method) {
    return { accessExpiresAt: access.exp * 1000, identityExpiresAt: access.idx * 1000, method: method || 'password' };
}

function publicUser(u) {
    return { id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at, toolbarEnabled: u.toolbar_enabled !== 0 };
}

// ------------------------------------------------------------- register ----
router.post('/register', (req, res) => {
    const mode = settings.get('registration_mode');
    if (mode === 'closed') return res.status(403).json({ error: 'Sign-up is closed. Ask an administrator for an account.' });
    if (!signups.hit(`signup:${req.ip}`, Number(process.env.SIGNUP_LIMIT_PER_HOUR) || 5)) return res.status(429).json({ error: 'Too many sign-ups from your network. Try again later.' });

    const { username, email, password, confirmPassword } = req.body || {};
    if (confirmPassword !== undefined && confirmPassword !== password) return res.status(400).json({ error: 'Passwords do not match' });
    let user;
    try {
        user = users.register({ username: String(username || '').trim(), email: String(email || '').trim() || null, password, needsApproval: mode === 'approval' });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    events.record('register', { userId: user.id, detail: mode === 'approval' ? 'pending approval' : 'active', ip: req.ip });
    if (mode === 'approval') return res.json({ ok: true, pending: true });
    const session = signIn(res, user, 'password');
    res.json({ ok: true, pending: false, user: publicUser(user), session });
});

// ---------------------------------------------------------------- login ----
router.post('/login', (req, res) => {
    const key = `login:${req.ip}`;
    const w = failures.windows.get(key);
    if (w && w.count >= MAX_FAILURES && w.reset > Date.now()) {
        res.set('Retry-After', String(failures.retryAfter(key)));
        return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const { username, password, token, continueAs } = req.body || {};
    const method = token ? 'token' : 'password';
    const result = token ? users.authenticateToken(token) : users.authenticatePassword(username, password);

    if (result.error) {
        if (result.error === 'invalid') failures.hit(key, MAX_FAILURES);
        events.record('login_failed', { detail: `${result.error} (${method === 'token' ? 'access code' : 'user ' + String(username || '').slice(0, 64)})`, ip: req.ip });
        const message = result.error === 'invalid' && method === 'token' ? 'Invalid access code' : LOGIN_ERRORS[result.error];
        return res.status(result.error === 'invalid' ? 401 : 403).json({ error: message, reason: result.error });
    }

    // Re-sign-in from the "session expired" prompt must be the SAME person,
    // otherwise the open page would continue as somebody else.
    if (continueAs && continueAs !== result.user.id) {
        return res.status(409).json({ error: 'Sign in with the same account to continue, or sign out first.', code: 'different_user' });
    }
    failures.reset(key);
    const session = signIn(res, result.user, method === 'token' ? 'access_code' : 'password');
    events.record(continueAs ? 'login_resumed' : 'login', { userId: result.user.id, detail: method === 'token' ? 'access code' : 'password', ip: req.ip });
    res.json({ ok: true, user: publicUser(result.user), session });
});

// -------------------------------------------------------------- refresh ----
router.post('/refresh', (req, res) => {
    const identity = readIdentity(req.cookies[COOKIE_IDENTITY]);
    if (!identity) return res.status(401).json({ error: 'Not logged in', code: 'not_signed_in' });
    if (!refreshes.hit(`refresh:${identity.claims.jti}`, 30)) return res.status(429).json({ error: 'Too many refreshes' });
    const user = users.getById(identity.claims.sub); // fresh read: revocation applies immediately
    if (!usable(user, identity.claims.tv)) {
        clearSignInCookies(res);
        return res.status(401).json({ error: 'Your sign-in is no longer valid', code: 'not_signed_in' });
    }
    if (identity.expired) {
        return res.status(401).json({ error: 'Your sign-in has expired', code: 'identity_expired', username: user.username, method: (identity.claims.amr || [])[0] === 'otp' ? 'access_code' : 'password' });
    }
    const access = setAccessCookie(res, user, identity.claims);
    res.json({ ok: true, user: publicUser(user), session: sessionInfo(access, (identity.claims.amr || [])[0] === 'otp' ? 'access_code' : 'password') });
});

// --------------------------------------------------------------- logout ----
router.post('/logout', (req, res) => {
    clearSignInCookies(res);
    if (req.user) {
        if ((req.body || {}).everywhere) {
            // Invalidates every login cookie of this user and ends their browsing sessions.
            users.update(req.user.id, { logoutEverywhere: true });
            sessions.requestEndForUser(req.user.id);
        }
        events.record('logout', { userId: req.user.id, detail: (req.body || {}).everywhere ? 'everywhere' : null, ip: req.ip });
    }
    // Next stop: the proxy hostname, to clear its cookie as well.
    res.json({ ok: true, redirect: `${config.proxyBaseUrl}/__portal/logout` });
});

// ------------------------------------------------------------------- me ----
router.get('/me', (req, res) => {
    // Signed in but the access token expired: let the browser renew it and retry.
    if (!req.user && req.auth && req.auth.state !== 'none') return unauthorized(req, res);
    const s = settings.getAll();
    res.json({
        user: req.user ? publicUser(req.user) : null,
        session: req.token ? sessionInfo(req.token, null) : null,
        portal: {
            title: s.portal_title,
            notice: s.portal_notice,
            registration: s.registration_mode,
            userProxies: s.user_proxies_enabled,
            allowDirect: s.allow_direct,
            searchServer: s.search_engine === 'google', // words -> /search results page (server browser)
            proxyBaseUrl: config.proxyBaseUrl
        }
    });
});

// ------------------------------------------------------------- password ----
router.post('/password', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    const { currentPassword, newPassword } = req.body || {};
    try {
        const updated = users.changeOwnPassword(req.user.id, currentPassword, newPassword);
        // Changing the password logs out other devices; keep THIS device signed in.
        signIn(res, updated, 'password');
        events.record('password_changed', { userId: req.user.id, ip: req.ip });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
