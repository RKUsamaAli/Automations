'use strict';
/**
 * Observability for the portal process.
 *
 *  requestId  - every request gets an id (from nginx's X-Request-Id or a new
 *               one), echoed in the response header and in every log line /
 *               error report, so one failure can be followed end to end.
 *  trail      - remembers the last ~40 portal actions of each user in memory
 *               (attached to error reports).
 *  requestLog - every portal page view / API call is stored (request_log
 *               table, batched) for activity analysis and debugging.
 *  metrics    - counts requests, errors and response times per minute.
 *  errorHandler - unexpected failures: 500 + error report (with the trail) +
 *               a reference the user can quote ("E-7K2P9Q").
 */
const crypto = require('crypto');
const Breadcrumbs = require('../../lib/breadcrumbs');
const errorReports = require('../../services/errorReports');
const context = require('../../lib/context');
const requestLog = require('../../services/requestLog');
const metrics = require('../../services/metrics');
const { redactUrl, safeHeaders, redactObject } = require('../../lib/redact');
const log = require('../../lib/logger')('web');

const trail = new Breadcrumbs({ size: 40 });
const SLOW_MS = 3000;

function requestId(req, res, next) {
    const incoming = req.get('X-Request-Id');
    req.id = incoming && /^[a-zA-Z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomBytes(8).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    req.startedAt = Date.now();
    next();
}

const trailKey = (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`);

/** Records each finished request into the user's trail (memory only). */
function recordTrail(req, res, next) {
    if (req.path === '/healthz' || req.path.startsWith('/assets/')) return next();
    const ctx = context.get(); // captured now: the 'finish' callback runs outside the request context
    res.on('finish', () => {
        const ms = Date.now() - req.startedAt;
        const isApi = req.originalUrl.startsWith('/api/');
        metrics.observe(res.statusCode, ms);
        requestLog.add({
            source: 'web',
            kind: isApi ? 'api' : 'view',
            userId: req.user ? req.user.id : null,
            method: req.method,
            url: req.originalUrl,
            host: req.hostname,
            status: res.statusCode,
            ms,
            requestId: req.id,
            ip: req.ip,
            clientId: ctx ? ctx.clientId : null
        });
        trail.add(trailKey(req), {
            type: isApi ? 'api' : 'page',
            method: req.method,
            url: redactUrl(req.originalUrl),
            status: res.statusCode,
            ms,
            requestId: req.id
        });
        if (ms > SLOW_MS) log.warn('slow request', { requestId: req.id, method: req.method, url: redactUrl(req.originalUrl), status: res.statusCode, ms, user: req.user ? req.user.id : null });
    });
    next();
}

/** Builds and stores a report for an unexpected server error. @returns ref */
function reportServerError(req, err, kind = 'server_exception') {
    return errorReports.report({
        source: 'web',
        kind,
        error: err,
        userId: req.user ? req.user.id : null,
        requestId: req.id,
        url: req.originalUrl,
        clientIp: req.ip,
        userAgent: req.get('user-agent'),
        context: {
            method: req.method,
            headers: safeHeaders(req.headers),
            body: req.body && typeof req.body === 'object' ? redactObject(req.body) : undefined,
            durationMs: Date.now() - (req.startedAt || Date.now())
        },
        breadcrumbs: trail.get(trailKey(req))
    });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    const ref = reportServerError(req, err);
    if (res.headersSent) return res.end();
    const message = `Something went wrong on our side.${ref ? ` Reference: ${ref}` : ''}`;
    if (req.originalUrl.startsWith('/api/')) return res.status(500).json({ error: message, ref });
    res.status(500).type('text/plain').send(message);
}

module.exports = { requestId, recordTrail, errorHandler, reportServerError, trail, trailKey };
