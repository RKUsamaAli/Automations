'use strict';
/**
 * PORTAL process - serves APP_DOMAIN (e.g. https://portal.example.com)
 *
 *   /login          sign in (password or access code)
 *   /register       create an account (setting registration_mode)
 *   /               browse: URL bar, proxy pool picker, site tiles, my sessions
 *   /proxies        my own upstream proxies
 *   /account        profile, change password, sign out
 *   /admin          admin panel
 *   /api/...        JSON API used by those pages
 *   /healthz        health probe used by deploy.sh (no auth)
 *
 * The actual proxying happens in the separate proxy process
 * (src/proxy/server.js) on PROXY_DOMAIN.
 *
 * Run:  node src/web/server.js   (PM2 app "portal-web", see ecosystem.config.js)
 */
const path = require('path');
const express = require('express');
const config = require('../config');
const db = require('../db');
const log = require('../lib/logger')('web');
const { securityHeaders, cookies, csrf } = require('./middleware/security');
const { loadUser, requireUser, requireAdmin } = require('./middleware/auth');
const { requestId, recordTrail, errorHandler } = require('./middleware/observability');

config.validate();
db.open();
db.assertMigrated();

const app = express();
const PUBLIC = path.join(__dirname, 'public');

app.disable('x-powered-by');
// nginx on 127.0.0.1 sets X-Forwarded-For; trust only the loopback hop.
if (config.trustProxy) app.set('trust proxy', 'loopback');

// Health probe first: no cookies, no auth, never cached.
app.get('/healthz', (_req, res) => {
    try {
        db.get().prepare('SELECT 1').get();
        res.set('Cache-Control', 'no-store').json({ ok: true, service: 'web', release: config.releaseName });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.use(requestId);
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(cookies);
app.use(csrf);
app.use(loadUser);
app.use(recordTrail);

// Static assets (css/js). HTML pages are served by explicit routes below.
app.use('/assets', express.static(PUBLIC, { index: false, maxAge: config.isProduction ? '1h' : 0 }));

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/portal', requireUser, require('./routes/portal'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Pages ----
const page = (file) => (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC, file));
app.get('/login', (req, res, next) => (req.user ? res.redirect('/') : page('login.html')(req, res, next)));
app.get('/register', (req, res, next) => (req.user ? res.redirect('/') : page('register.html')(req, res, next)));
app.get('/logout', (_req, res) => res.redirect('/account')); // signing out is a POST (CSRF-safe)
app.get('/', requireUser, page('index.html'));
app.get('/proxies', requireUser, page('proxies.html'));
app.get('/account', requireUser, page('account.html'));
app.get('/admin', requireAdmin, page('admin.html'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use((_req, res) => res.status(404).send('Not found'));
// Unexpected failures -> 500 + error report with the user's recent steps + reference.
app.use(errorHandler);

const server = app.listen(config.web.port, config.web.host, () => {
    log.info(`portal listening on http://${config.web.host}:${config.web.port} (public: ${config.appBaseUrl}, release: ${config.releaseName})`);
    // Tell PM2 we are ready (used with wait_ready for zero-downtime reloads).
    if (process.send) process.send('ready');
});

// Graceful shutdown: finish in-flight requests, then exit (PM2 sends SIGINT).
function shutdown(signal) {
    log.info(`${signal} received, closing portal`);
    server.close(() => {
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
