'use strict';
/**
 * Observability for the proxy engine.
 *
 * TRAIL (memory only, per browsing session): every page the user opens, plus
 * any sub-request that FAILED (4xx/5xx/aborted). Successful images/scripts are
 * not recorded - a page can load 100+ of them and they tell us nothing.
 *
 * REPORTS are written when:
 *   - a page cannot be loaded at all (upstream proxy down, site unreachable,
 *     timeout, TLS error ...)          -> kind page_load_failed (+ friendly page with reference)
 *   - the site/upstream answers a page with 5xx or 407 -> kind site_error / upstream_auth_failed
 *   - our own code throws               -> kind server_exception (+ error page with reference)
 */
const config = require('../config');
const Breadcrumbs = require('../lib/breadcrumbs');
const errorReports = require('../services/errorReports');
const requestLog = require('../services/requestLog');
const metrics = require('../services/metrics');
const sessionsService = require('../services/sessions');
const pools = require('../services/pools');
const { describeProxy } = require('../lib/proxyString');
const { redactUrl, safeHeaders } = require('../lib/redact');
const { renderMessage } = require('./pages');
const log = require('../lib/logger')('proxy');

const trail = new Breadcrumbs({ size: 40 });
const keyOf = (sid) => `sess:${sid}`;

/** Called when a proxied response finishes (see guard.js). */
function recordRequest({ sid, req, res, parsed, navigation, startedAt, userId, proxyId = null, bytes = null, aborted = false }) {
    const status = aborted ? 0 : res.statusCode;
    const failed = aborted || status >= 400;
    const ms = Date.now() - startedAt;
    metrics.observe(status, ms);
    // Stored activity log (pages + failures by default; REQUEST_LOG_LEVEL=all for everything).
    requestLog.add({
        source: 'proxy',
        kind: navigation ? 'page' : 'resource',
        userId,
        sessionId: sid,
        method: req.method,
        url: parsed ? parsed.destUrl : req.url,
        host: parsed ? parsed.host : null,
        status,
        ms,
        bytes,
        proxyId,
        requestId: req.portalRequestId,
        error: aborted ? 'connection closed before the response finished' : null,
        ip: req.portalClientIp
    });
    if (!navigation && !failed) return; // successful resources: nothing to keep
    const crumb = {
        type: navigation ? 'page' : 'resource',
        method: req.method,
        url: parsed ? redactUrl(parsed.destUrl) : redactUrl(req.url),
        status: aborted ? 'aborted' : status,
        ms: Date.now() - startedAt
    };
    trail.add(keyOf(sid), crumb);

    if (navigation && (status >= 500 || status === 407)) {
        const row = sessionsService.getCached(sid);
        errorReports.report({
            source: 'proxy',
            kind: status === 407 ? 'upstream_auth_failed' : 'site_error',
            severity: status === 407 ? 'error' : 'warning',
            error: status === 407 ? 'Upstream proxy rejected its credentials (HTTP 407)' : `Page answered HTTP ${status}`,
            userId,
            sessionId: sid,
            requestId: req.portalRequestId,
            url: parsed ? parsed.destUrl : req.url,
            destHost: parsed ? parsed.host : null,
            proxyId: row && row.proxy_id,
            poolId: row && row.pool_id,
            clientIp: req.portalClientIp,
            userAgent: req.headers['user-agent'],
            context: { status, upstream: describeUpstream(row) },
            breadcrumbs: trail.get(keyOf(sid))
        });
    }
}

function describeUpstream(row) {
    if (!row || !row.proxy_id) return 'direct (no upstream proxy)';
    const p = pools.getProxyWithSecrets(row.proxy_id);
    return p ? `${describeProxy(p)} [#${p.id}, status ${p.status}]` : `proxy #${row.proxy_id} (deleted)`;
}

/** Plain-language reason for the user + a category for the report. */
function classify(err) {
    const msg = String((err && (err.message || err.code)) || err || '');
    const code = String((err && err.code) || '');
    if (/407|Proxy Authentication/i.test(msg)) return ['upstream_auth', 'The upstream proxy rejected its login. The administrator has been notified.'];
    if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return ['connect_refused', 'The connection was refused (the upstream proxy or the website is down).'];
    if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(msg)) return ['dns', 'This website address could not be found.'];
    if (/timeout|ETIMEDOUT|within the timeout period/i.test(msg)) return ['timeout', 'The website took too long to answer.'];
    if (/ECONNRESET|socket hang up|EPIPE/i.test(msg)) return ['reset', 'The connection was interrupted (the upstream proxy or the website closed it).'];
    if (/certificate|SSL|TLS|EPROTO/i.test(msg)) return ['tls', 'A secure (HTTPS) connection to the website could not be established.'];
    return ['other', 'The website could not be loaded.'];
}

function errorPage({ title, message, ref, retryUrl }) {
    return renderMessage({
        title,
        message,
        linkText: 'Back to portal',
        linkHref: config.appBaseUrl,
        secondaryText: retryUrl ? 'Try again' : null,
        secondaryHref: retryUrl || null,
        reference: ref
    });
}

/**
 * Replacement for Rammerhead's no-op `handlePageError`. Without it the browser
 * waits until the stuck-request timeout (minutes) on a failed page load.
 * hammerhead calls it as handlePageError(ctx, err) for top-level pages.
 */
function makePageErrorHandler(session) {
    return function handlePageError(ctx, err) {
        try {
            const sid = session.id;
            const row = sessionsService.getCached(sid);
            const destUrl = (ctx && ctx.dest && ctx.dest.url) || null;
            const [category, reason] = classify(err);
            const req = ctx && ctx.req;
            trail.add(keyOf(sid), { type: 'page', method: req ? req.method : 'GET', url: redactUrl(destUrl), status: 'failed', error: category });
            requestLog.add({
                source: 'proxy', kind: 'page', userId: row ? row.user_id : null, sessionId: sid, method: req ? req.method : 'GET',
                url: destUrl, host: ctx && ctx.dest ? ctx.dest.hostname : null, status: 0, proxyId: row && row.proxy_id,
                requestId: req && req.portalRequestId, error: `${category}: ${err && err.message ? err.message : err}`
            });
            const ref = errorReports.report({
                source: 'proxy',
                kind: 'page_load_failed',
                error: err instanceof Error ? err : String(err),
                userId: row ? row.user_id : null,
                sessionId: sid,
                requestId: req && req.portalRequestId,
                url: destUrl,
                destHost: ctx && ctx.dest ? ctx.dest.hostname : null,
                proxyId: row && row.proxy_id,
                poolId: row && row.pool_id,
                clientIp: req && req.portalClientIp,
                userAgent: req && req.headers['user-agent'],
                context: { category, upstream: describeUpstream(row), headers: req ? safeHeaders(req.headers) : undefined },
                breadcrumbs: trail.get(keyOf(sid))
            });
            const res = ctx && ctx.res;
            if (res && !res.headersSent && !res.writableEnded) {
                res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(errorPage({ title: "This page couldn't load", message: reason, ref, retryUrl: req ? req.url : null }));
            } else if (res && !res.writableEnded) {
                res.end();
            }
        } catch (e) {
            log.error('page error handler failed', e);
            try {
                if (ctx && ctx.res && !ctx.res.writableEnded) ctx.res.end();
            } catch (_) {
                /* nothing left to do */
            }
        }
    };
}

/** Our own code failed while handling a proxy request. */
function reportGuardException(req, res, err, isWebsocket) {
    const ref = errorReports.report({
        source: 'proxy',
        kind: 'server_exception',
        error: err,
        userId: req.portalUser ? req.portalUser.id : null,
        requestId: req.portalRequestId,
        url: req.url,
        clientIp: req.portalClientIp,
        userAgent: req.headers['user-agent'],
        context: { method: req.method, headers: safeHeaders(req.headers) }
    });
    try {
        if (isWebsocket) return res.end('HTTP/1.1 500 Error\r\n\r\n');
        if (res.headersSent) return res.end();
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(errorPage({ title: 'Something went wrong', message: 'The portal hit an unexpected problem.', ref }));
    } catch (_) {
        /* socket gone */
    }
}

module.exports = { trail, recordRequest, makePageErrorHandler, reportGuardException, classify };
