'use strict';
/**
 * Admin API (all routes require role=admin, mounted at /api/admin).
 *
 *   GET  /overview
 *   Users     : GET/POST /users, PATCH/DELETE /users/:id, POST/DELETE /users/:id/token, POST /users/:id/logout,
 *               POST /users/:id/approve
 *   Pools     : GET/POST /pools, PUT/DELETE /pools/:id, GET /pools/:id/proxies,
 *               GET/PUT /pools/:id/access  (which users may use an "assigned" pool),
 *               POST /pools/:id/import, POST /pools/:id/check, DELETE /pools/:id/dead
 *   Proxies   : PATCH/DELETE /proxies/:id
 *   Sites     : GET/POST /sites, PUT/DELETE /sites/:id
 *   Scripts   : GET/POST /scripts, PUT/DELETE /scripts/:id
 *   Settings  : GET/PUT /settings
 *   Sessions  : GET /sessions, POST /sessions/:id/end
 *   Logs      : GET /usage, GET /events, GET /events.csv (export)
 *   Requests  : GET /requests, GET /requests.csv, GET /sessions/:id/timeline
 *   Server    : GET /server (metrics, processes, lifecycle), GET /proxies/:id/checks
 *   Errors    : GET /errors, GET /errors/:ref, POST /errors/:id/resolve, POST /errors/:id/reopen,
 *               POST /errors/group/:fingerprint/resolve, GET /errors.jsonl (export)
 */
const express = require('express');
const users = require('../../services/users');
const pools = require('../../services/pools');
const sites = require('../../services/sites');
const scripts = require('../../services/scripts');
const settings = require('../../services/settings');
const sessions = require('../../services/sessions');
const usage = require('../../services/usage');
const events = require('../../services/events');
const healthCheck = require('../../jobs/healthCheck');
const config = require('../../config');
const errorReports = require('../../services/errorReports');
const requestLog = require('../../services/requestLog');
const metrics = require('../../services/metrics');
const { isBug } = require('../../lib/errors');

const router = express.Router();
const id = (req) => Number(req.params.id);

/**
 * Wraps handlers: validation errors -> 400 with the message; real bugs
 * (see lib/errors.js) -> the error handler (500 + error report + reference).
 */
const h = (fn) => (req, res, next) => {
    const fail = (e) => (isBug(e) ? next(e) : res.status(400).json({ error: e.message }));
    try {
        const out = fn(req, res);
        if (out && typeof out.then === 'function') {
            out.then((v) => !res.headersSent && res.json(v ?? { ok: true })).catch(fail);
        } else if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
        fail(e);
    }
};

const audit = (req, type, detail) => events.record(type, { userId: req.user.id, detail, ip: req.ip });

// ------------------------------------------------------------ overview ----
router.get(
    '/overview',
    h(() => {
        const poolList = pools.listPools();
        return {
            release: config.releaseName,
            sessions: sessions.stats(),
            users: users.count(),
            pendingUsers: users.countPending(),
            openErrors: errorReports.countOpen(),
            pools: poolList.length,
            proxies: poolList.reduce((a, p) => a + p.proxy_count, 0),
            usableProxies: poolList.reduce((a, p) => a + p.usable_count, 0),
            usageToday: usage.daily(1)[0] || { requests: 0, bytes: 0 },
            daily: usage.daily(14),
            recentEvents: events.list({ limit: 15 })
        };
    })
);

// --------------------------------------------------------------- users ----

/**
 * Lazy-loading helper. With ?paged=1 a list endpoint answers
 *   { items, nextCursor, summary }   (summary only on the first batch)
 * Without it the old plain-array answer is kept (CSV, pickers, scripts).
 */
const isPaged = (req) => req.query.paged === '1' || req.query.paged === 'true';
function paged(req, pageFn, summaryFn) {
    const opts = { cursor: req.query.cursor || null, limit: req.query.limit };
    const result = pageFn(opts);
    if (!opts.cursor && summaryFn) result.summary = summaryFn();
    return result;
}
router.get(
    '/users',
    h((req) => {
        if (!isPaged(req)) return users.list();
        const f = { q: req.query.q || '', pending: req.query.pending === '1' };
        return paged(req, (o) => users.page(f, o), () => users.pageSummary({ q: f.q }));
    })
);
router.post(
    '/users',
    h((req) => {
        const b = req.body || {};
        const result = users.create({
            username: b.username,
            password: b.password,
            role: b.role,
            generateToken: !!b.generateToken,
            poolId: b.poolId,
            rateLimitRpm: b.rateLimitRpm,
            bandwidthLimitMbDay: b.bandwidthLimitMbDay,
            note: b.note,
            email: b.email || null
        });
        audit(req, 'admin_user_created', result.user.username);
        return result;
    })
);
router.patch(
    '/users/:id',
    h((req) => {
        const b = req.body || {};
        const target = users.getById(id(req));
        if (!target) throw new Error('User not found');
        // Never lock yourself (or everyone) out.
        const demotingOrDisabling = (b.role && b.role !== 'admin') || b.enabled === false;
        if (target.role === 'admin' && demotingOrDisabling && users.countAdmins() <= 1) {
            throw new Error('You cannot disable or demote the last admin');
        }
        const updated = users.update(id(req), b);
        if (b.enabled === false) sessions.requestEndForUser(id(req));
        audit(req, 'admin_user_updated', updated.username);
        return updated;
    })
);
router.delete(
    '/users/:id',
    h((req) => {
        const target = users.getById(id(req));
        if (!target) throw new Error('User not found');
        if (target.id === req.user.id) throw new Error('You cannot delete your own account');
        if (target.role === 'admin' && users.countAdmins() <= 1) throw new Error('You cannot delete the last admin');
        sessions.requestEndForUser(target.id);
        users.remove(target.id);
        audit(req, 'admin_user_deleted', target.username);
    })
);
router.post(
    '/users/:id/approve',
    h((req) => {
        const u = users.approve(id(req));
        audit(req, 'admin_user_approved', u.username);
        return u;
    })
);
router.post('/users/:id/token', h((req) => ({ accessToken: users.regenerateToken(id(req)) })));
router.delete('/users/:id/token', h((req) => users.revokeToken(id(req))));
router.post(
    '/users/:id/logout',
    h((req) => {
        users.update(id(req), { logoutEverywhere: true });
        sessions.requestEndForUser(id(req));
    })
);

// --------------------------------------------------------------- pools ----
const poolInput = (b) => ({
    name: b.name,
    country: b.country,
    type: b.type,
    isDefault: !!b.isDefault,
    description: b.description,
    visibility: b.visibility === 'assigned' ? 'assigned' : 'all'
});
router.get('/pools', h(() => ({ pools: pools.listPools(), types: pools.POOL_TYPES })));
router.post('/pools', h((req) => pools.savePool(poolInput(req.body || {}))));
router.put('/pools/:id', h((req) => pools.savePool({ id: id(req), ...poolInput(req.body || {}) })));
router.delete(
    '/pools/:id',
    h((req) => {
        pools.deletePool(id(req));
        audit(req, 'admin_pool_deleted', String(id(req)));
    })
);
router.get(
    '/pools/:id/proxies',
    h((req) => {
        const poolId = id(req);
        if (!isPaged(req)) return pools.listProxies(poolId);
        const f = { status: req.query.status || '', q: req.query.q || '' };
        return paged(req, (o) => pools.pageProxies(poolId, f, o), () => pools.proxySummary(poolId));
    })
);
router.get('/pools/:id/access', h((req) => ({ userIds: pools.getPoolAccess(id(req)) })));
router.put(
    '/pools/:id/access',
    h((req) => {
        const userIds = pools.setPoolAccess(id(req), (req.body || {}).userIds);
        audit(req, 'admin_pool_access', `pool ${id(req)}: ${userIds.length} user(s)`);
        return { userIds };
    })
);
router.post(
    '/pools/:id/import',
    h((req) => {
        const b = req.body || {};
        const result = pools.importProxies(id(req), b.text, b.defaultProtocol || 'http');
        audit(req, 'admin_proxies_imported', `pool ${id(req)}: +${result.added}`);
        // Check the new proxies straight away so they become "healthy".
        if (result.added) healthCheck.checkAll({ poolId: id(req) }).catch(() => {});
        return result;
    })
);
router.post(
    '/pools/:id/check',
    h(async (req) => {
        const result = await healthCheck.checkAll({ poolId: id(req) });
        if (result.skipped) throw new Error('A health check is already running, try again in a moment');
        return result;
    })
);
router.delete('/pools/:id/dead', h((req) => ({ deleted: pools.deleteDeadProxies(id(req)) })));
router.patch('/proxies/:id', h((req) => pools.setProxyEnabled(id(req), !!(req.body || {}).enabled)));
router.delete('/proxies/:id', h((req) => pools.deleteProxy(id(req))));

// --------------------------------------------------------------- sites ----
const siteInput = (b) => ({
    name: b.name,
    startUrl: b.startUrl,
    domains: b.domains,
    poolId: b.poolId ? Number(b.poolId) : null,
    enabled: b.enabled !== false,
    showOnLanding: b.showOnLanding !== false,
    sortOrder: b.sortOrder
});
router.get('/sites', h(() => sites.list()));
router.post('/sites', h((req) => sites.save(siteInput(req.body || {}))));
router.put('/sites/:id', h((req) => sites.save({ id: id(req), ...siteInput(req.body || {}) })));
router.delete('/sites/:id', h((req) => sites.remove(id(req))));

// ------------------------------------------------------------- scripts ----
const scriptInput = (b) => ({
    name: b.name,
    domains: b.domains,
    runAt: b.runAt,
    loadOrder: b.loadOrder,
    enabled: b.enabled !== false,
    code: b.code
});
router.get('/scripts', h(() => ({ scripts: scripts.list(), runAt: scripts.RUN_AT })));
router.post(
    '/scripts',
    h((req) => {
        const s = scripts.save(scriptInput(req.body || {}));
        audit(req, 'admin_script_saved', s.name);
        return s;
    })
);
router.put(
    '/scripts/:id',
    h((req) => {
        const s = scripts.save({ id: id(req), ...scriptInput(req.body || {}) });
        audit(req, 'admin_script_saved', s.name);
        return s;
    })
);
router.delete('/scripts/:id', h((req) => scripts.remove(id(req))));

// ------------------------------------------------------------ settings ----
router.get('/settings', h(() => ({ values: settings.getAll(), defaults: settings.DEFAULTS })));
router.put(
    '/settings',
    h((req) => {
        const v = settings.update(req.body || {});
        audit(req, 'admin_settings_updated', Object.keys(req.body || {}).join(','));
        return v;
    })
);

// ------------------------------------------------------ sessions & logs ----
router.get('/sessions', h((req) => (isPaged(req) ? paged(req, (o) => sessions.pageActive(o), () => sessions.activeSummary()) : sessions.listActive())));
router.post(
    '/sessions/:id/end',
    h((req) => {
        sessions.requestEnd(req.params.id);
        audit(req, 'admin_session_ended', req.params.id.slice(0, 8));
    })
);
router.get('/usage', h((req) => ({ users: usage.summary(Number(req.query.days) || 7), daily: usage.daily(Number(req.query.days) || 14) })));
router.get(
    '/events',
    h((req) => {
        const f = { type: req.query.type || null, userId: Number(req.query.userId) || null };
        if (!isPaged(req)) return events.list({ ...f, limit: req.query.limit });
        return paged(req, (o) => events.page(f, o), () => events.pageSummary(f));
    })
);

// ---- exports for data analysis (Excel / pandas / jq) ----
const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    // quote, and neutralise spreadsheet formulas
    return '"' + (/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
};
router.get('/events.csv', (req, res) => {
    const rows = events.list({ limit: 1000000 }).reverse();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="portal-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write('time_utc,event,user_id,username,detail,ip\n');
    for (const e of rows) res.write([new Date(e.created_at).toISOString(), e.type, e.user_id, e.username, e.detail, e.ip].map(csvCell).join(',') + '\n');
    res.end();
});

// ------------------------------------------------------------- requests ----
const reqFilter = (q) => ({
    userId: q.user,
    sessionId: q.session,
    kind: q.kind,
    status: q.status,
    q: q.q,
    since: q.hours ? Date.now() - Number(q.hours) * 3600000 : undefined,
    limit: q.limit
});
router.get(
    '/requests',
    h((req) => {
        const f = reqFilter(req.query);
        if (!isPaged(req)) return requestLog.list(f);
        return paged(req, (o) => requestLog.page(f, o), () => requestLog.pageSummary(f));
    })
);
router.get('/requests.csv', (req, res) => {
    const rows = requestLog.list({ ...reqFilter(req.query), since: Date.now() - (Number(req.query.hours) || 24) * 3600000, limit: 100000 }).reverse();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="portal-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write('time_utc,source,kind,username,session,method,status,ms,bytes,host,url,proxy_id,request_id,error\n');
    for (const r of rows) {
        res.write([new Date(r.ts).toISOString(), r.source, r.kind, r.username, r.session_id ? r.session_id.slice(0, 8) : '', r.method, r.status, r.ms, r.bytes, r.host, r.url, r.proxy_id, r.request_id, r.error].map(csvCell).join(',') + '\n');
    }
    res.end();
});
router.get(
    '/sessions/:id/timeline',
    h((req) => {
        const s = sessions.get(req.params.id);
        if (!s) throw new Error('Session not found');
        const user = users.getById(s.user_id);
        const session = { ...s, username: user ? user.username : null };
        if (!isPaged(req)) return { session, requests: requestLog.sessionTimeline(s.id) };
        const result = paged(req, (o) => requestLog.sessionTimelinePage(s.id, o), () => requestLog.sessionTimelineSummary(s.id));
        if (!req.query.cursor) result.session = session;
        return result;
    })
);

// --------------------------------------------------------------- server ----
router.get(
    '/server',
    h((req) => {
        const hours = Math.min(Number(req.query.hours) || 24, 24 * 14);
        const series = metrics.series(hours);
        const latest = {};
        for (const m of series) latest[m.process] = m; // last row per process
        return {
            hours,
            series,
            processes: Object.values(latest).sort((a, b) => a.process.localeCompare(b.process)),
            lifecycle: events.list({ limit: 300 }).filter((e) => e.type.startsWith('process_')).slice(0, 30),
            traffic: requestLog.summary(Math.min(hours, 72))
        };
    })
);
router.get('/proxies/:id/checks', h((req) => pools.proxyChecks(id(req))));

// --------------------------------------------------------------- errors ----
router.get(
    '/errors',
    h((req) => {
        const f = { status: req.query.status || 'open', q: req.query.q || '' };
        if (!isPaged(req)) return { reports: errorReports.list(f), open: errorReports.countOpen() };
        return paged(req, (o) => errorReports.page(f, o), () => ({ ...errorReports.pageSummary(f), openAll: errorReports.countOpen() }));
    })
);
router.get('/errors.jsonl', (req, res) => {
    const days = Math.min(Number(req.query.days) || 7, 90);
    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="portal-errors-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    for (const r of errorReports.exportRange(Date.now() - days * 86400000)) res.write(JSON.stringify(r) + '\n');
    res.end();
});
router.get(
    '/errors/:ref',
    h((req) => {
        const r = errorReports.get(req.params.ref);
        if (!r) throw new Error('Error report not found');
        return r;
    })
);
router.post('/errors/:id/resolve', h((req) => errorReports.setResolved(id(req), true, req.user.id, (req.body || {}).note || null)));
router.post('/errors/:id/reopen', h((req) => errorReports.setResolved(id(req), false, req.user.id, null)));
router.post('/errors/group/:fingerprint/resolve', h((req) => ({ resolved: errorReports.resolveGroup(req.params.fingerprint, req.user.id) })));

module.exports = router;
