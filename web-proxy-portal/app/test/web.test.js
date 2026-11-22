'use strict';
/**
 * End-to-end tests of the portal HTTP API (real Express server on a random port).
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const users = require('../src/services/users');
const { readTicket } = require('../src/lib/authTokens');

let base;
let server;

test.before(async () => {
    users.create({ username: 'admin1', password: 'adminpass123', role: 'admin' });
    users.create({ username: 'user1', password: 'userpass123' });
    ({ server } = require('../src/web/server'));
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

/** Minimal cookie-jar client. */
function client() {
    const jar = {};
    const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    async function req(method, path, body, extraHeaders = {}) {
        const headers = { cookie: cookieHeader(), ...extraHeaders };
        if (jar.pp_csrf && !('x-csrf-token' in extraHeaders)) headers['x-csrf-token'] = decodeURIComponent(jar.pp_csrf);
        if (body !== undefined) headers['content-type'] = 'application/json';
        const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(';');
            const i = pair.indexOf('=');
            jar[pair.slice(0, i)] = pair.slice(i + 1);
        }
        let json = null;
        const text = await res.text();
        try {
            json = JSON.parse(text);
        } catch (_) {
            /* html */
        }
        return { status: res.status, json, headers: res.headers, text };
    }
    return { req, jar };
}

test('health endpoint is public', async () => {
    const r = await client().req('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
});

test('pages redirect to login when signed out; security headers present', async () => {
    const c = client();
    const r = await c.req('GET', '/');
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/login/);
    const login = await c.req('GET', '/login');
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(c.jar.pp_csrf, 'csrf cookie issued');
});

test('CSRF token required for state-changing requests', async () => {
    const c = client();
    await c.req('GET', '/login');
    const r = await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' }, { 'x-csrf-token': 'wrong' });
    assert.equal(r.status, 403);
});

test('login, browse ticket, allowlist and private-address protection', async () => {
    const c = client();
    await c.req('GET', '/login');
    const bad = await c.req('POST', '/api/auth/login', { username: 'user1', password: 'nope' });
    assert.equal(bad.status, 401);
    const ok = await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    assert.equal(ok.status, 200);
    assert.ok(c.jar.pp_login);

    const b = await c.req('POST', '/api/portal/browse', { url: 'example.com/path?q=1' });
    assert.equal(b.status, 200);
    const t = new URL(b.json.redirect);
    assert.equal(t.host, 'browse.test');
    assert.equal(t.pathname, '/__portal/start');
    const ticket = readTicket(t.searchParams.get('t'));
    assert.equal(ticket.url, 'https://example.com/path?q=1');

    for (const url of ['http://127.0.0.1/', 'http://192.168.1.10', 'localhost:3000', 'https://portal.test/', 'javascript:alert(1)']) {
        const r = await c.req('POST', '/api/portal/browse', { url });
        assert.equal(r.status, 400, `${url} must be rejected`);
    }
    // a domain that merely starts with "fc" is NOT private
    assert.equal((await c.req('POST', '/api/portal/browse', { url: 'fcbarcelona.com' })).status, 200);

    const admin = await c.req('GET', '/api/admin/overview');
    assert.equal(admin.status, 403, 'normal users cannot use the admin API');
});

test('admin can manage pools, sites, scripts, settings', async () => {
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });

    const pool = await c.req('POST', '/api/admin/pools', { name: 'Test pool', type: 'datacenter' });
    assert.equal(pool.status, 200, JSON.stringify(pool.json));
    const imp = await c.req('POST', `/api/admin/pools/${pool.json.id}/import`, { text: '203.0.113.5:8080:u:p' });
    assert.equal(imp.json.added, 1);
    const proxies = await c.req('GET', `/api/admin/pools/${pool.json.id}/proxies`);
    assert.equal(proxies.json.length, 1);
    assert.equal(proxies.json[0].password, undefined, 'proxy passwords are never sent to the browser');

    const site = await c.req('POST', '/api/admin/sites', { name: 'Example', startUrl: 'https://www.example.org/', domains: '*.example.org', poolId: pool.json.id });
    assert.equal(site.status, 200, JSON.stringify(site.json));
    const badScript = await c.req('POST', '/api/admin/scripts', { name: 'x', domains: '*', code: 'if (' });
    assert.equal(badScript.status, 400);

    const s = await c.req('PUT', '/api/admin/settings', { allowlist_enabled: true });
    assert.equal(s.json.allowlist_enabled, true);

    // allowlist now active for users
    const u = client();
    await u.req('GET', '/login');
    await u.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    assert.equal((await u.req('POST', '/api/portal/browse', { url: 'https://not-allowed.net/' })).status, 403);
    assert.equal((await u.req('POST', '/api/portal/browse', { url: 'https://shop.example.org/' })).status, 200);
    await c.req('PUT', '/api/admin/settings', { allowlist_enabled: false });

    // last admin protection
    const me = (await c.req('GET', '/api/auth/me')).json.user;
    assert.equal((await c.req('PATCH', `/api/admin/users/${me.id}`, { role: 'user' })).status, 400);
});

test('disabled user is logged out immediately', async () => {
    const c = client();
    await c.req('GET', '/login');
    users.create({ username: 'temp1', password: 'temppass123' });
    await c.req('POST', '/api/auth/login', { username: 'temp1', password: 'temppass123' });
    assert.equal((await c.req('GET', '/api/portal/sessions')).status, 200);
    const id = (await c.req('GET', '/api/auth/me')).json.user.id;
    users.update(id, { enabled: false });
    assert.equal((await c.req('GET', '/api/portal/sessions')).status, 401);
});
