'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const users = require('../src/services/users');
const pools = require('../src/services/pools');
const sites = require('../src/services/sites');
const scripts = require('../src/services/scripts');
const settings = require('../src/services/settings');
const sessions = require('../src/services/sessions');
const usage = require('../src/services/usage');

test('users: create, password + token login, disable', () => {
    const { user, accessToken } = users.create({ username: 'alice', password: 'password123', generateToken: true });
    assert.equal(user.role, 'user');
    assert.ok(accessToken);
    assert.equal(users.authenticatePassword('alice', 'password123').id, user.id);
    assert.equal(users.authenticatePassword('ALICE', 'password123').id, user.id, 'usernames are case-insensitive');
    assert.equal(users.authenticatePassword('alice', 'nope'), null);
    assert.equal(users.authenticateToken(accessToken).id, user.id);
    const before = users.getById(user.id).token_version;
    users.update(user.id, { enabled: false });
    assert.equal(users.authenticatePassword('alice', 'password123'), null);
    assert.equal(users.getById(user.id).token_version, before + 1, 'disabling bumps token_version');
    assert.throws(() => users.create({ username: 'alice', password: 'password123' }), /exists/);
    assert.throws(() => users.create({ username: 'x', password: 'password123' }), /Username/);
});

test('pools: import, default pool, least-loaded pick, health', () => {
    const us = pools.savePool({ name: 'US resi', type: 'residential', country: 'US' });
    assert.equal(us.is_default, 1, 'first pool becomes default');
    const uk = pools.savePool({ name: 'UK isp', type: 'isp' });
    const r = pools.importProxies(us.id, 'http://u:p@10.0.0.1:8000\n10.0.0.2:8000:u:p\nhttp://u:p@10.0.0.1:8000');
    assert.equal(r.added, 2);
    assert.equal(r.skipped, 1);
    pools.importProxies(uk.id, 'socks5://u:p@10.1.0.1:1080');

    const [a, b] = pools.listProxies(us.id);
    pools.recordHealth(a.id, { ok: true, latencyMs: 100, slowMs: 5000, failuresBeforeDead: 3 });
    pools.recordHealth(b.id, { ok: true, latencyMs: 100, slowMs: 5000, failuresBeforeDead: 3 });

    const owner = users.create({ username: 'bob', password: 'password123' }).user;
    sessions.create({ id: 'a'.repeat(32), userId: owner.id, poolId: us.id, proxyId: a.id });
    assert.equal(pools.pickProxy(us.id).id, b.id, 'least loaded proxy is picked');

    for (let i = 0; i < 3; i++) pools.recordHealth(b.id, { ok: false, error: 'x', slowMs: 5000, failuresBeforeDead: 3 });
    assert.equal(pools.listProxies(us.id).find((p) => p.id === b.id).status, 'dead');
    assert.equal(pools.pickProxy(us.id).id, a.id, 'dead proxy is never picked');
    assert.equal(pools.pickProxy(us.id, [a.id]), null);

    // pool resolution: user override > site > default
    sites.save({ name: 'UK site', startUrl: 'https://www.uksite.co.uk/', domains: '*.uksite.co.uk', poolId: uk.id });
    assert.equal(pools.resolvePoolId({}, 'https://shop.uksite.co.uk/x', sites.listEnabled()), uk.id);
    assert.equal(pools.resolvePoolId({}, 'https://other.com/', sites.listEnabled()), us.id);
    assert.equal(pools.resolvePoolId({ pool_id: uk.id }, 'https://other.com/', sites.listEnabled()), uk.id);
});

test('sites: validation and allowlist', () => {
    assert.throws(() => sites.save({ name: 'x', startUrl: 'https://a.com', domains: 'b.com' }), /not covered/);
    assert.throws(() => sites.save({ name: 'x', startUrl: 'ftp://a.com', domains: 'a.com' }), /valid http/);
    assert.ok(sites.isHostAllowed('random.org'), 'allowlist disabled -> everything allowed');
    settings.update({ allowlist_enabled: true, allowlist_extra: '*.extra.net' });
    assert.ok(sites.isHostAllowed('www.uksite.co.uk'));
    assert.ok(sites.isHostAllowed('cdn.extra.net'));
    assert.ok(!sites.isHostAllowed('random.org'));
    settings.update({ allowlist_enabled: false });
});

test('scripts: validation, matching, ordering, bundle isolation', () => {
    assert.throws(() => scripts.save({ name: 'bad', code: 'function (' }), /syntax/i);
    scripts.save({ name: 'second', domains: '*', loadOrder: 20, code: 'window.__order = (window.__order||[]).concat(2);' });
    scripts.save({ name: 'first', domains: '*.example.com', loadOrder: 10, code: 'window.__order = (window.__order||[]).concat(1);' });
    scripts.save({ name: 'off', domains: '*', enabled: false, code: 'window.__off = 1;' });
    scripts.save({ name: 'boom', domains: '*', loadOrder: 15, runAt: 'document-start', code: 'throw new Error("x")' });

    const bundle = scripts.buildBundle('https://www.example.com/', 'www.example.com');
    // Execute the bundle in a fake browser-ish sandbox.
    const vm = require('node:vm');
    const ctx = { console: { warn() {} }, setTimeout, document: { readyState: 'complete', addEventListener() {} } };
    ctx.window = ctx;
    vm.runInNewContext(bundle, ctx);
    assert.deepEqual(Array.from(ctx.__order), [1, 2], 'load order respected, failing script isolated');
    assert.equal(ctx.__off, undefined, 'disabled script not included');
    assert.equal(ctx.__portal.page.host, 'www.example.com');

    const other = scripts.buildBundle('https://other.org/', 'other.org');
    assert.ok(!other.includes('"first"'), 'domain-specific script not included elsewhere');
    const unknown = scripts.buildBundle(null, null);
    assert.ok(unknown.includes('"second"') && !unknown.includes('"first"'), 'unknown page -> only * scripts');
});

test('settings: defaults and coercion', () => {
    assert.equal(settings.get('upstream_fallback'), 'deny');
    settings.update({ rate_limit_rpm: '300', allowlist_strict: 'true', unknown_key: 1 });
    assert.equal(settings.get('rate_limit_rpm'), 300);
    assert.equal(settings.get('allowlist_strict'), true);
    assert.throws(() => settings.update({ upstream_fallback: 'maybe' }));
    assert.throws(() => settings.update({ rate_limit_rpm: -1 }));
});

test('usage: track + flush aggregates per user and session', () => {
    const u = users.create({ username: 'carol', password: 'password123' }).user;
    const sid = 'c'.repeat(32);
    sessions.create({ id: sid, userId: u.id });
    usage.track(u.id, sid, 1000);
    usage.track(u.id, sid, 500);
    assert.equal(usage.bytesToday(u.id), 1500, 'pending bytes counted before flush');
    usage.flush();
    assert.equal(usage.bytesToday(u.id), 1500);
    const row = sessions.get(sid);
    assert.equal(row.bytes, 1500);
    assert.equal(row.requests, 2);
});
