'use strict';
/**
 * POST /api/client-errors - errors that happen in the BROWSER on portal pages
 * (JavaScript exceptions, failed API calls). The page sends the error plus
 * its own trail of what the user did (pages, clicks, API calls); we add the
 * server-side trail and store one error report.
 *
 * Works signed in or out (the sign-in page can fail too). Rate limited.
 */
const express = require('express');
const RateLimiter = require('../../lib/rateLimiter');
const { trail, trailKey } = require('../middleware/observability');
const errorReports = require('../../services/errorReports');

const router = express.Router();
const limiter = new RateLimiter(60000);
const KINDS = ['client_js', 'client_promise', 'api_error', 'network_error'];

const clean = (v, max) => (v == null ? undefined : String(v).slice(0, max));

router.post('/', (req, res) => {
    if (!limiter.hit(`ce:${req.ip}`, 20)) return res.status(429).json({ error: 'Too many reports' });
    const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : 'client_js';
    const clientCrumbs = (Array.isArray(b.crumbs) ? b.crumbs : []).slice(-40).map((c) => ({
        t: Number(c.t) || Date.now(),
        type: `browser:${clean(c.type, 20) || 'step'}`,
        label: clean(c.label, 200),
        url: clean(c.url, 300),
        status: c.status != null ? Number(c.status) : undefined,
        ms: c.ms != null ? Number(c.ms) : undefined
    }));
    const ref = errorReports.report({
        source: 'client',
        kind,
        severity: kind === 'api_error' && Number(b.status) < 500 ? 'warning' : 'error',
        error: clean(b.message, 1000) || 'Unknown browser error',
        stack: clean(b.stack, 4000),
        userId: req.user ? req.user.id : null,
        requestId: clean(b.requestId, 64),
        url: clean(b.page, 600),
        clientIp: req.ip,
        userAgent: req.get('user-agent'),
        context: {
            source: clean(b.source, 300),
            line: b.line,
            column: b.column,
            api: b.api ? { method: clean(b.api.method, 10), url: clean(b.api.url, 300), status: b.api.status } : undefined,
            viewport: clean(b.viewport, 40),
            online: b.online
        },
        breadcrumbs: [...trail.get(trailKey(req)), ...clientCrumbs]
    });
    res.json({ ok: true, ref });
});

module.exports = router;
