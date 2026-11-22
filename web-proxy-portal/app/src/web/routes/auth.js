'use strict';
/**
 * Login / logout API.
 *
 *   POST /api/auth/login   { username, password }  or  { token }
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 */
const express = require('express');
const users = require('../../services/users');
const events = require('../../services/events');
const settings = require('../../services/settings');
const config = require('../../config');
const RateLimiter = require('../../lib/rateLimiter');
const { COOKIE_LOGIN, mintLogin, serializeCookie } = require('../../lib/authTokens');

const router = express.Router();

// Brute-force protection: 10 failed attempts per 15 min per IP (nginx adds another layer).
const failures = new RateLimiter(15 * 60000);
const MAX_FAILURES = 10;

router.post('/login', (req, res) => {
    const ip = req.ip;
    const key = `login:${ip}`;
    const w = failures.windows.get(key);
    if (w && w.count >= MAX_FAILURES && w.reset > Date.now()) {
        res.set('Retry-After', String(failures.retryAfter(key)));
        return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }

    const { username, password, token } = req.body || {};
    let user = null;
    let method;
    if (token) {
        method = 'token';
        user = users.authenticateToken(token);
    } else {
        method = 'password';
        user = users.authenticatePassword(username, password);
    }

    if (!user) {
        failures.hit(key, MAX_FAILURES);
        events.record('login_failed', { detail: method === 'token' ? 'access token' : `username: ${String(username || '').slice(0, 64)}`, ip });
        return res.status(401).json({ error: method === 'token' ? 'Invalid access code' : 'Invalid username or password' });
    }

    failures.reset(key);
    const { token: cookie, exp } = mintLogin(user);
    res.append('Set-Cookie', serializeCookie(COOKIE_LOGIN, cookie, { maxAgeSec: (exp - Date.now()) / 1000 }));
    events.record('login', { userId: user.id, detail: method, ip });
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
    res.append('Set-Cookie', serializeCookie(COOKIE_LOGIN, '', { maxAgeSec: 0 }));
    if (req.user) events.record('logout', { userId: req.user.id, ip: req.ip });
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    const s = settings.getAll();
    res.json({
        user: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
        portal: { title: s.portal_title, notice: s.portal_notice, proxyBaseUrl: config.proxyBaseUrl }
    });
});

module.exports = router;
