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
const suggest = require('../../services/suggest');
const clientDevices = require('../../services/clientDevices');
const sessionProxy = require('../../services/sessionProxy');
const tzlib = require('../../lib/timezone');
const { isId, idOrNull } = require('../../lib/ids');
const { diff, describe } = require('../../lib/audit');
const TtlCache = require('../../lib/ttlCache');
const requestLog = require('../../services/requestLog');
const metrics = require('../../services/metrics');
const { isBug } = require('../../lib/errors');

const router = express.Router();
/** Route :id as a GUID; anything else is a 404 ("not found"), never a DB error. */
const id = (req) => {
    if (!isId(req.params.id)) throw Object.assign(new Error('Not found'), { status: 404 });
    return req.params.id;
};

/**
 * Wraps handlers: validation errors -> 400 with the message; real bugs
 * (see lib/errors.js) -> the error handler (500 + error report + reference).
 */
const h = (fn) => (req, res, next) => {
    const fail = (e) => (isBug(e) ? next(e) : res.status(e.status || 400).json({ error: e.message }));
    try {
        const out = fn(req, res);
        if (out && typeof out.then === 'function') {
            out.then((v) => !res.headersSent && res.json(v ?? { ok: true })).catch(fail);
        } else if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
        fail(e);
    }
};

/**
 * Activity log entry for an admin action.
 *   audit(req, 'admin_site_updated', 'Example shop', { target: 'site:<id>', changes: diff(before, after, [...]) })
 * Who / ip / request id / device / server are added automatically.
 */
const audit = (req, type, detail, { target = null, changes = null, level = 'info' } = {}) => {
    const text = changes && Object.keys(changes).length ? `${detail}: ${describe(changes)}` : detail;
    events.record(type, { userId: req.user.id, detail: text, ip: req.ip, target, changes, level });
};
const USER_FIELDS = ['role', 'enabled', 'email', 'pool_id', 'rate_limit_rpm', 'bandwidth_limit_mb_day', 'note', 'pending'];
const POOL_FIELDS = ['name', 'country', 'type', 'is_default', 'description', 'visibility'];
const SITE_FIELDS = ['name', 'start_url', 'domains', 'pool_id', 'enabled', 'show_on_landing', 'sort_order'];
const SCRIPT_FIELDS = ['name', 'domains', 'run_at', 'load_order', 'enabled', 'code'];

// ------------------------------------------------------------ overview ----
// Heavy aggregates (dashboard, server health) are cached for a few seconds:
// several admins / quick tab switches reuse the same result.
const microCache = new TtlCache(5000, 200);
router.get(
    '/overview',
    h((req) => microCache.get(`overview|${req.tz}`, () => overview(req)))
);
function overview(req) {
    const poolList = pools.listPools();
    return {
        release: config.releaseName,
        timezone: req.tz, // "today" below = since local midnight in this zone
        sessions: sessions.stats(req.tz),
        users: users.count(),
        pendingUsers: users.countPending(),
        openErrors: errorReports.countOpen(),
        pools: poolList.length,
        proxies: poolList.reduce((a, p) => a + p.proxy_count, 0),
        usableProxies: poolList.reduce((a, p) => a + p.usable_count, 0),
        usageToday: usage.today(req.tz),
        daily: usage.daily(14, req.tz),
        recentEvents: events.list({ limit: 15 })
    };
}

// --------------------------------------------------------------- users ----

/**
 * Lazy-loading helper. With ?paged=1 a list endpoint answers
 *   { items, nextCursor, summary }   (summary only on the first batch)
 * Without it the old plain-array answer is kept (CSV, pickers, scripts).
 */
// ------------------------------------------------------- suggestions ----
// One endpoint for every type-ahead box: ?field=users|hosts|domains|proxyHosts|errors&q=
router.get(
    '/suggest',
    h((req) => {
        const q = req.query.q || '';
        switch (req.query.field) {
            case 'users':
                return suggest.users(q);
            case 'hosts':
                return suggest.hosts(q);
            case 'domains':
                return suggest.domainPatterns(q);
            case 'proxyHosts':
                return suggest.proxyHosts(idOrNull(req.query.pool), q);
            case 'errors':
                // reference numbers first, then sites with errors, then users
                return { refs: suggest.errorRefs(q), hosts: suggest.hosts(q, { limit: 4 }), users: suggest.users(q, { limit: 4 }) };
            default:
                throw new Error('Unknown suggestion field');
        }
    })
);

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
        audit(req, 'admin_user_created', `${result.user.username} (${result.user.role})`, {
            target: `user:${result.user.id}`,
            changes: diff(null, { ...result.user, password: b.password ? 'set' : undefined, access_code: result.accessToken ? 'set' : undefined }, [...USER_FIELDS, 'password', 'access_code'])
        });
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
        const changes = diff(target, updated, USER_FIELDS);
        if (b.password) changes.password = ['***', 'changed'];
        audit(req, 'admin_user_updated', updated.username, { target: `user:${updated.id}`, changes });
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
        audit(req, 'admin_user_deleted', `${target.username} (${target.role})`, { target: `user:${target.id}`, level: 'warn' });
    })
);
router.post(
    '/users/:id/approve',
    h((req) => {
        const u = users.approve(id(req));
        audit(req, 'admin_user_approved', u.username, { target: `user:${u.id}`, changes: { pending: [1, 0] } });
        return u;
    })
);
router.post(
    '/users/:id/token',
    h((req) => {
        const u = users.getById(id(req));
        if (!u) throw new Error('User not found');
        const accessToken = users.regenerateToken(u.id);
        audit(req, 'admin_access_code_created', u.username, { target: `user:${u.id}`, changes: { access_code: ['***', 'changed'] } });
        return { accessToken };
    })
);
router.delete(
    '/users/:id/token',
    h((req) => {
        const u = users.getById(id(req));
        if (!u) throw new Error('User not found');
        users.revokeToken(u.id);
        audit(req, 'admin_access_code_revoked', u.username, { target: `user:${u.id}` });
    })
);
router.post(
    '/users/:id/logout',
    h((req) => {
        const u = users.update(id(req), { logoutEverywhere: true });
        sessions.requestEndForUser(id(req));
        audit(req, 'admin_user_signed_out', `${u.username}: signed out everywhere, sessions ended`, { target: `user:${u.id}` });
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
router.post(
    '/pools',
    h((req) => {
        const p = pools.savePool(poolInput(req.body || {}));
        audit(req, 'admin_pool_created', p.name, { target: `pool:${p.id}`, changes: diff(null, p, POOL_FIELDS) });
        return p;
    })
);
router.put(
    '/pools/:id',
    h((req) => {
        const before = pools.getPool(id(req));
        if (!before) throw new Error('Pool not found');
        const p = pools.savePool({ id: before.id, ...poolInput(req.body || {}) });
        audit(req, 'admin_pool_updated', p.name, { target: `pool:${p.id}`, changes: diff(before, p, POOL_FIELDS) });
        return p;
    })
);
router.delete(
    '/pools/:id',
    h((req) => {
        const before = pools.getPool(id(req));
        if (!before) throw new Error('Pool not found');
        pools.deletePool(before.id);
        audit(req, 'admin_pool_deleted', before.name, { target: `pool:${before.id}`, level: 'warn' });
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
        const before = pools.getPoolAccess(id(req));
        const userIds = pools.setPoolAccess(id(req), (req.body || {}).userIds);
        const pool = pools.getPool(id(req));
        const names = (list) => list.map((u) => (users.getById(u) || { username: u }).username).sort();
        const added = userIds.filter((u) => !before.includes(u));
        const removed = before.filter((u) => !userIds.includes(u));
        audit(req, 'admin_pool_access', `${pool ? pool.name : id(req)}: ${userIds.length} user(s)` + (added.length ? `, added ${names(added).join(', ')}` : '') + (removed.length ? `, removed ${names(removed).join(', ')}` : ''), {
            target: `pool:${id(req)}`
        });
        return { userIds };
    })
);
router.post(
    '/pools/:id/import',
    h((req) => {
        const b = req.body || {};
        const result = pools.importProxies(id(req), b.text, b.defaultProtocol || 'http');
        audit(req, 'admin_proxies_imported', `${(pools.getPool(id(req)) || {}).name}: ${result.added} added, ${result.skipped} duplicates, ${result.errors.length} invalid`, { target: `pool:${id(req)}` });
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
        audit(req, 'admin_proxies_checked', `${(pools.getPool(id(req)) || {}).name}: ${result.checked} checked, ${result.healthy || 0} online, ${result.slow || 0} slow, ${result.dead || 0} offline`, { target: `pool:${id(req)}` });
        return result;
    })
);
const proxyLabel = (x) => (x ? `${x.protocol}://${x.host}:${x.port}` : 'proxy');
router.delete(
    '/pools/:id/dead',
    h((req) => {
        const deleted = pools.deleteDeadProxies(id(req));
        audit(req, 'admin_dead_proxies_removed', `${(pools.getPool(id(req)) || {}).name}: ${deleted} removed`, { target: `pool:${id(req)}` });
        return { deleted };
    })
);
router.patch(
    '/proxies/:id',
    h((req) => {
        const x = pools.getProxyWithSecrets(id(req));
        if (!x) throw new Error('Proxy not found');
        const enabled = !!(req.body || {}).enabled;
        pools.setProxyEnabled(x.id, enabled);
        audit(req, enabled ? 'admin_proxy_enabled' : 'admin_proxy_disabled', proxyLabel(x), { target: `proxy:${x.id}`, changes: { enabled: [x.enabled, enabled ? 1 : 0] } });
    })
);
router.delete(
    '/proxies/:id',
    h((req) => {
        const x = pools.getProxyWithSecrets(id(req));
        if (!x) throw new Error('Proxy not found');
        pools.deleteProxy(x.id);
        audit(req, 'admin_proxy_removed', proxyLabel(x), { target: `proxy:${x.id}` });
    })
);

// --------------------------------------------------------------- sites ----
const siteInput = (b) => ({
    name: b.name,
    startUrl: b.startUrl,
    domains: b.domains,
    poolId: idOrNull(b.poolId),
    enabled: b.enabled !== false,
    showOnLanding: b.showOnLanding !== false,
    sortOrder: b.sortOrder
});
router.get('/sites', h(() => sites.list()));
router.post(
    '/sites',
    h((req) => {
        const s = sites.save(siteInput(req.body || {}));
        audit(req, 'admin_site_created', s.name, { target: `site:${s.id}`, changes: diff(null, s, SITE_FIELDS) });
        return s;
    })
);
router.put(
    '/sites/:id',
    h((req) => {
        const before = sites.get(id(req));
        if (!before) throw new Error('Site not found');
        const s = sites.save({ id: before.id, ...siteInput(req.body || {}) });
        audit(req, 'admin_site_updated', s.name, { target: `site:${s.id}`, changes: diff(before, s, SITE_FIELDS) });
        return s;
    })
);
router.delete(
    '/sites/:id',
    h((req) => {
        const before = sites.get(id(req));
        if (!before) throw new Error('Site not found');
        sites.remove(before.id);
        audit(req, 'admin_site_deleted', before.name, { target: `site:${before.id}`, level: 'warn' });
    })
);

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
        audit(req, 'admin_script_created', s.name, { target: `script:${s.id}`, changes: diff(null, s, SCRIPT_FIELDS.filter((f) => f !== 'code')) });
        return s;
    })
);
router.put(
    '/scripts/:id',
    h((req) => {
        const before = scripts.get(id(req));
        if (!before) throw new Error('Script not found');
        const s = scripts.save({ id: before.id, ...scriptInput(req.body || {}) });
        const changes = diff(before, s, SCRIPT_FIELDS.filter((f) => f !== 'code'));
        if (before.code !== s.code) changes.code = [`${before.code.length} chars`, `${s.code.length} chars`];
        audit(req, 'admin_script_updated', s.name, { target: `script:${s.id}`, changes });
        return s;
    })
);
router.delete(
    '/scripts/:id',
    h((req) => {
        const before = scripts.get(id(req));
        if (!before) throw new Error('Script not found');
        scripts.remove(before.id);
        audit(req, 'admin_script_deleted', before.name, { target: `script:${before.id}`, level: 'warn' });
    })
);

// ------------------------------------------------------------ settings ----
router.get('/settings', h(() => ({ values: settings.getAll(), defaults: settings.DEFAULTS })));
router.put(
    '/settings',
    h((req) => {
        const before = settings.getAll();
        const v = settings.update(req.body || {});
        audit(req, 'admin_settings_updated', 'Settings', { target: 'settings', changes: diff(before, v, Object.keys(settings.DEFAULTS)) });
        return v;
    })
);

// ------------------------------------------------------ sessions & logs ----
router.get(
    '/sessions',
    h((req) => {
        if (!isPaged(req)) return sessions.listActive();
        const userId = idOrNull(req.query.user);
        return paged(req, (o) => sessions.pageActive({ ...o, userId }), () => sessions.activeSummary({ userId }));
    })
);
router.post(
    '/sessions/:id/end',
    h((req) => {
        const s = sessions.get(req.params.id);
        if (!s) throw new Error('Session not found');
        sessions.requestEnd(s.id);
        const owner = users.getById(s.user_id);
        audit(req, 'admin_session_ended', `${owner ? owner.username : 'user'}: session ${s.id.slice(0, 8)} (${s.start_url || ''})`, { target: `session:${s.id}` });
    })
);
router.get(
    '/sessions/:id/proxies',
    h((req) => {
        const s = sessions.get(req.params.id);
        if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
        return { current: s.proxy_id, pools: sessionProxy.choices(req.user, s, { admin: true }) };
    })
);
router.post(
    '/sessions/:id/proxy',
    h((req) => {
        const s = sessions.get(req.params.id);
        if (!s) throw Object.assign(new Error('Session not found'), { status: 404 });
        return sessionProxy.change(s, String((req.body || {}).proxyId || ''), { user: req.user, admin: true });
    })
);
router.get('/usage', h((req) => ({ timezone: req.tz, users: usage.summary(Number(req.query.days) || 7, req.tz), daily: usage.daily(Number(req.query.days) || 14, req.tz) })));
router.get(
    '/events',
    h((req) => {
        const f = { type: req.query.type || null, userId: idOrNull(req.query.userId), source: req.query.source || null, level: req.query.level || null, q: req.query.q || null };
        if (!isPaged(req)) return events.list({ ...f, limit: req.query.limit });
        return paged(req, (o) => events.page(f, o), () => events.pageSummary(f));
    })
);

router.get(
    '/events/:id',
    h((req) => {
        const e = events.getOne(id(req));
        if (!e) throw Object.assign(new Error('Not found'), { status: 404 });
        return e;
    })
);
router.get(
    '/devices/:id',
    h((req) => {
        const d = clientDevices.get(id(req));
        if (!d) throw Object.assign(new Error('Not found'), { status: 404 });
        return d;
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
    res.set('Content-Disposition', `attachment; filename="portal-events-${tzlib.dayKey(Date.now(), req.tz)}.csv"`);
    res.write(`time_utc,time_local (${req.tz}),event,level,source,user_id,username,detail,target,changes,ip,browser,os,device,screen,server,process,release,request_id\n`);
    for (const e of rows) {
        res.write(
            [new Date(e.created_at).toISOString(), tzlib.formatLocal(e.created_at, req.tz), e.type, e.level, e.source, e.user_id, e.username, e.detail, e.target, e.changes, e.ip,
                e.browser ? `${e.browser} ${e.browser_version || ''}`.trim() : '', e.os ? `${e.os} ${e.os_version || ''}`.trim() : '', [e.device_type, e.device_model].filter(Boolean).join(' '), e.screen,
                e.server, e.process, e.release, e.request_id].map(csvCell).join(',') + '\n'
        );
    }
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
    res.set('Content-Disposition', `attachment; filename="portal-requests-${tzlib.dayKey(Date.now(), req.tz)}.csv"`);
    res.write(`time_utc,time_local (${req.tz}),source,kind,username,session,method,status,ms,bytes,host,url,proxy_id,request_id,error,ip,browser,os,device,screen,server,process\n`);
    for (const r of rows) {
        res.write([new Date(r.ts).toISOString(), tzlib.formatLocal(r.ts, req.tz), r.source, r.kind, r.username, r.session_id ? r.session_id.slice(0, 8) : '', r.method, r.status, r.ms, r.bytes, r.host, r.url, r.proxy_id, r.request_id, r.error, r.ip, r.browser ? `${r.browser} ${r.browser_version || ''}`.trim() : '', r.os ? `${r.os} ${r.os_version || ''}`.trim() : '', [r.device_type, r.device_model].filter(Boolean).join(' '), r.screen, r.server, r.process].map(csvCell).join(',') + '\n');
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
    h((req) => microCache.get(`server|${req.query.hours || ''}`, () => serverHealth(req)))
);
function serverHealth(req) {
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
}
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
    res.set('Content-Disposition', `attachment; filename="portal-errors-${tzlib.dayKey(Date.now(), req.tz)}.jsonl"`);
    // Timestamps stay UTC epoch ms; *_local fields are added for reading in the viewer's zone.
    for (const r of errorReports.exportRange(Date.now() - days * 86400000)) {
        res.write(JSON.stringify({ ...r, timezone: req.tz, created_at_local: tzlib.formatLocal(r.created_at, req.tz), last_seen_at_local: tzlib.formatLocal(r.last_seen_at, req.tz) }) + '\n');
    }
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
router.post(
    '/errors/:id/resolve',
    h((req) => {
        const r = errorReports.get(id(req));
        if (!r) throw new Error('Report not found');
        const note = (req.body || {}).note || null;
        errorReports.setResolved(r.id, true, req.user.id, note);
        audit(req, 'admin_error_resolved', `${r.ref}: ${r.message.slice(0, 80)}${note ? ' (note: ' + String(note).slice(0, 80) + ')' : ''}`, { target: `error:${r.id}` });
    })
);
router.post(
    '/errors/:id/reopen',
    h((req) => {
        const r = errorReports.get(id(req));
        if (!r) throw new Error('Report not found');
        errorReports.setResolved(r.id, false, req.user.id, null);
        audit(req, 'admin_error_reopened', r.ref, { target: `error:${r.id}` });
    })
);
router.post(
    '/errors/group/:fingerprint/resolve',
    h((req) => {
        const resolved = errorReports.resolveGroup(req.params.fingerprint, req.user.id);
        audit(req, 'admin_error_group_resolved', `${resolved} similar report(s) resolved (fingerprint ${String(req.params.fingerprint).slice(0, 16)})`, { target: `error-group:${req.params.fingerprint}` });
        return { resolved };
    })
);

module.exports = router;
