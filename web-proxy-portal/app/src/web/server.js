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
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const log = require('../lib/logger')('web');
const { securityHeaders, cookies, csrf } = require('./middleware/security');
const { timezone } = require('./middleware/timezone');
const { apiRateLimit } = require('./middleware/rateLimit');
const { loadUser, requireUser, requireAdmin } = require('./middleware/auth');
const { requestId, recordTrail, errorHandler } = require('./middleware/observability');
const metrics = require('../services/metrics');
const requestLog = require('../services/requestLog');
const clientDevices = require('../services/clientDevices');
const events = require('../services/events');
const context = require('../lib/context');
const system = require('../lib/system');

system.setProcessName(`web:${process.env.NODE_APP_INSTANCE || 0}`);
events.setSource('web');

config.validate();
db.open();
db.assertMigrated();

const app = express();
const PUBLIC = path.join(__dirname, 'public');

/** Short hash of every css/js file: changes whenever any of them changes. */
function assetVersion() {
    const h = crypto.createHash('sha1');
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(dir, f.name);
            if (f.isDirectory()) walk(p);
            else if (/\.(css|js|svg|png|ico|woff2?)$/.test(f.name)) h.update(f.name).update(fs.readFileSync(p));
        }
    };
    walk(PUBLIC);
    return h.digest('hex').slice(0, 8);
}

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
// Static assets (css/js) first: they need no cookies, user or database work.
// Pages reference them as /assets/v-<content hash>/..., cached for a year
// ("immutable"); any change to a file changes the hash, so a deploy is picked
// up immediately. Un-versioned /assets/... URLs still work (short cache).
const ASSET_VERSION = assetVersion();
const staticFiles = express.static(PUBLIC, { index: false, maxAge: config.isProduction ? '5m' : 0 });
const versionedFiles = express.static(PUBLIC, { index: false, maxAge: '365d', immutable: true });
app.use('/assets', (req, res, next) => {
    const m = /^\/v-[0-9a-f]{8}(\/.*)$/.exec(req.url);
    if (!m) return staticFiles(req, res, next);
    req.url = m[1];
    return versionedFiles(req, res, next);
});
app.use(express.json({ limit: '1mb' }));
app.use(cookies);
app.use(csrf);
app.use(loadUser);
app.use(timezone);
// Request context: who is acting + request id + device, read by services to
// fill created_by/updated_by and by the activity log. Lives for the whole request.
app.use((req, res, next) => {
    context.run({ userId: req.user ? req.user.id : null, requestId: req.id, ip: req.ip, source: 'web', clientId: clientDevices.fromRequest(req) }, next);
});
app.use(recordTrail);
app.use(apiRateLimit); // after recordTrail so refused calls are visible in the request log

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/client-errors', require('./routes/clientErrors'));
app.use('/api/portal', requireUser, require('./routes/portal'));
app.use('/api/admin', requireAdmin, require('./routes/admin'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Pages ----
// Read once per process and kept in memory, with asset URLs versioned.
const pageCache = new Map();
function pageHtml(file) {
    let html = pageCache.get(file);
    if (!html) {
        html = fs.readFileSync(path.join(PUBLIC, file), 'utf8').replace(/(["'])\/assets\//g, `$1/assets/v-${ASSET_VERSION}/`);
        if (config.isProduction) pageCache.set(file, html);
    }
    return html;
}
const page = (file) => (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(pageHtml(file));
app.get('/login', (req, res, next) => (req.user ? res.redirect('/') : page('login.html')(req, res, next)));
app.get('/register', (req, res, next) => (req.user ? res.redirect('/') : page('register.html')(req, res, next)));
app.get('/logout', (_req, res) => res.redirect('/account')); // signing out is a POST (CSRF-safe)
app.get('/', page('index.html')); // start page: works signed out too (searching asks to sign in)
app.get('/sessions', requireUser, page('sessions.html'));
app.get('/search', requireUser, page('search.html'));
app.get('/live', requireUser, page('live.html'));
app.get('/proxies', requireUser, page('proxies.html'));
app.get('/account', requireUser, page('account.html'));
app.get('/admin', requireAdmin, page('admin.html'));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use((_req, res) => res.status(404).send('Not found'));
// Unexpected failures -> 500 + error report with the user's recent steps + reference.
app.use(errorHandler);

const server = app.listen(config.web.port, config.web.host, () => {
    log.info(`portal listening on http://${config.web.host}:${config.web.port} (public: ${config.appBaseUrl}, release: ${config.releaseName})`);
    // Health metrics + lifecycle events; one name per PM2 instance ("web:0", "web:1").
    if (process.env.NODE_ENV !== 'test') metrics.start(`web:${process.env.NODE_APP_INSTANCE || 0}`);
    // Tell PM2 we are ready (used with wait_ready for zero-downtime reloads).
    if (process.send) process.send('ready');
});
// Live browser WebSocket: handed through to portal-live (127.0.0.1:LIVE_PORT),
// which checks the ticket. Same origin only.
server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/live/ws?')) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && origin !== config.appBaseUrl) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const up = require('net').connect(Number(process.env.LIVE_PORT) || 3004, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    });
    up.setNoDelay(true);
    socket.setNoDelay(true);
    up.on('error', () => socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'));
    socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
});

// Keep idle connections from nginx open longer than nginx's own keepalive
// (60 s), so nginx never reuses a socket Node.js just closed (-> random 502s).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Graceful shutdown: finish in-flight requests, then exit (PM2 sends SIGINT).
function shutdown(signal) {
    log.info(`${signal} received, closing portal`);
    metrics.stop(signal);
    requestLog.flush();
    server.close(() => {
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
