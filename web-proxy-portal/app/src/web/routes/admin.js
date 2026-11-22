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
 *   Logs      : GET /usage, GET /events
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

const router = express.Router();
const id = (req) => Number(req.params.id);

/** Wraps handlers so thrown validation errors become 400 JSON responses. */
const h = (fn) => (req, res) => {
    try {
        const out = fn(req, res);
        if (out && typeof out.then === 'function') {
            out.then((v) => !res.headersSent && res.json(v ?? { ok: true })).catch((e) => res.status(400).json({ error: e.message }));
        } else if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
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
router.get('/users', h(() => users.list()));
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
router.get('/pools/:id/proxies', h((req) => pools.listProxies(id(req))));
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
router.get('/sessions', h(() => sessions.listActive()));
router.post(
    '/sessions/:id/end',
    h((req) => {
        sessions.requestEnd(req.params.id);
        audit(req, 'admin_session_ended', req.params.id.slice(0, 8));
    })
);
router.get('/usage', h((req) => ({ users: usage.summary(Number(req.query.days) || 7), daily: usage.daily(Number(req.query.days) || 14) })));
router.get('/events', h((req) => events.list({ limit: req.query.limit, type: req.query.type || null, userId: Number(req.query.userId) || null })));

module.exports = router;
