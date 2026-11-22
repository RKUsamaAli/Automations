'use strict';
/**
 * Authentication API.
 *
 *   POST /api/auth/register  { username, email?, password }     self sign-up (setting registration_mode)
 *   POST /api/auth/login     { username, password } | { token }
 *   POST /api/auth/logout    { everywhere? }
 *   GET  /api/auth/me        current user + public portal settings
 *   POST /api/auth/password  { currentPassword, newPassword }    change own password
 */
const express = require('express');
const users = require('../../services/users');
const events = require('../../services/events');
const settings = require('../../services/settings');
const sessions = require('../../services/sessions');
const config = require('../../config');
const RateLimiter = require('../../lib/rateLimiter');
const { COOKIE_LOGIN, mintLogin, serializeCookie } = require('../../lib/authTokens');

const router = express.Router();

// Brute-force protection: 10 failed attempts per 15 min per IP (nginx adds another layer).
const failures = new RateLimiter(15 * 60000);
const MAX_FAILURES = 10;
// Sign-up spam protection: 5 registrations per hour per IP.
const signups = new RateLimiter(60 * 60000);

const LOGIN_ERRORS = {
    invalid: 'Invalid username or password',
    pending: 'Your account is waiting for an administrator to approve it.',
    disabled: 'Your account has been disabled. Contact the administrator.'
};

function setLoginCookie(res, user) {
    const { token, exp } = mintLogin(user);
    res.append('Set-Cookie', serializeCookie(COOKIE_LOGIN, token, { maxAgeSec: (exp - Date.now()) / 1000 }));
}

function publicUser(u) {
    return { id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.created_at, lastLoginAt: u.last_login_at };
}

// ------------------------------------------------------------- register ----
router.post('/register', (req, res) => {
    const mode = settings.get('registration_mode');
    if (mode === 'closed') return res.status(403).json({ error: 'Sign-up is closed. Ask an administrator for an account.' });
    if (!signups.hit(`signup:${req.ip}`, 5)) return res.status(429).json({ error: 'Too many sign-ups from your network. Try again later.' });

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
    setLoginCookie(res, user);
    res.json({ ok: true, pending: false, user: publicUser(user) });
});

// ---------------------------------------------------------------- login ----
router.post('/login', (req, res) => {
    const key = `login:${req.ip}`;
    const w = failures.windows.get(key);
    if (w && w.count >= MAX_FAILURES && w.reset > Date.now()) {
        res.set('Retry-After', String(failures.retryAfter(key)));
        return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const { username, password, token } = req.body || {};
    const method = token ? 'token' : 'password';
    const result = token ? users.authenticateToken(token) : users.authenticatePassword(username, password);

    if (result.error) {
        if (result.error === 'invalid') failures.hit(key, MAX_FAILURES);
        events.record('login_failed', { detail: `${result.error} (${method === 'token' ? 'access code' : 'user ' + String(username || '').slice(0, 64)})`, ip: req.ip });
        const message = result.error === 'invalid' && method === 'token' ? 'Invalid access code' : LOGIN_ERRORS[result.error];
        return res.status(result.error === 'invalid' ? 401 : 403).json({ error: message, reason: result.error });
    }

    failures.reset(key);
    setLoginCookie(res, result.user);
    events.record('login', { userId: result.user.id, detail: method, ip: req.ip });
    res.json({ ok: true, user: publicUser(result.user) });
});

// --------------------------------------------------------------- logout ----
router.post('/logout', (req, res) => {
    res.append('Set-Cookie', serializeCookie(COOKIE_LOGIN, '', { maxAgeSec: 0 }));
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
    const s = settings.getAll();
    res.json({
        user: req.user ? publicUser(req.user) : null,
        portal: {
            title: s.portal_title,
            notice: s.portal_notice,
            registration: s.registration_mode,
            userProxies: s.user_proxies_enabled,
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
        setLoginCookie(res, updated);
        events.record('password_changed', { userId: req.user.id, ip: req.ip });
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
