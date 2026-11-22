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

test('sign-up -> pending -> admin approves -> sign in -> change password -> sign out', async () => {
    const anon = client();
    await anon.req('GET', '/register');
    const reg = await anon.req('POST', '/api/auth/register', { username: 'signup1', email: 's1@example.com', password: 'signuppass1', confirmPassword: 'signuppass1' });
    assert.equal(reg.status, 200, JSON.stringify(reg.json));
    assert.equal(reg.json.pending, true, 'default mode needs approval');
    const early = await anon.req('POST', '/api/auth/login', { username: 'signup1', password: 'signuppass1' });
    assert.equal(early.status, 403);
    assert.equal(early.json.reason, 'pending');

    const admin = client();
    await admin.req('GET', '/login');
    await admin.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const pendingUser = (await admin.req('GET', '/api/admin/users')).json.find((u) => u.username === 'signup1');
    assert.equal(pendingUser.pending, 1);
    assert.equal((await admin.req('POST', `/api/admin/users/${pendingUser.id}/approve`)).status, 200);

    const ok = await anon.req('POST', '/api/auth/login', { username: 'signup1', password: 'signuppass1' });
    assert.equal(ok.status, 200);
    assert.equal((await anon.req('POST', '/api/auth/password', { currentPassword: 'wrong', newPassword: 'whatever12' })).status, 400);
    assert.equal((await anon.req('POST', '/api/auth/password', { currentPassword: 'signuppass1', newPassword: 'newsignup12' })).status, 200);
    assert.equal((await anon.req('GET', '/api/portal/sessions')).status, 200, 'still signed in on this device after password change');
    await anon.req('POST', '/api/auth/logout', {});
    assert.equal((await anon.req('GET', '/api/portal/sessions')).status, 401, 'signed out');

    // closed / open modes
    await admin.req('PUT', '/api/admin/settings', { registration_mode: 'closed' });
    const closed = client();
    await closed.req('GET', '/register');
    const rc = await closed.req('POST', '/api/auth/register', { username: 'signup2', password: 'signuppass2' });
    assert.equal(rc.status, 403);
    assert.match(rc.json.error, /closed/);
    await admin.req('PUT', '/api/admin/settings', { registration_mode: 'open' });
    const open = client();
    await open.req('GET', '/register');
    const r2 = await open.req('POST', '/api/auth/register', { username: 'signup3', password: 'signuppass3' });
    assert.equal(r2.json.pending, false);
    assert.equal((await open.req('GET', '/api/portal/sessions')).status, 200, 'open mode signs in immediately');
    await admin.req('PUT', '/api/admin/settings', { registration_mode: 'approval' });
});

test('users manage their own proxies; admins share pools with chosen users', async () => {
    const admin = client();
    await admin.req('GET', '/login');
    await admin.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const pool = (await admin.req('POST', '/api/admin/pools', { name: 'Assigned only', visibility: 'assigned' })).json;
    const user1 = (await admin.req('GET', '/api/admin/users')).json.find((u) => u.username === 'user1');
    await admin.req('PUT', `/api/admin/pools/${pool.id}/access`, { userIds: [user1.id] });

    const u = client();
    await u.req('GET', '/login');
    await u.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    const visible = (await u.req('GET', '/api/portal/pools')).json.map((p) => p.name);
    assert.ok(visible.includes('Assigned only'));

    const add = await u.req('POST', '/api/portal/proxies', { text: 'http://a:b@127.0.0.1:3000\n9.9.9.9:8080:a:b' });
    assert.equal(add.status, 200);
    assert.equal(add.json.added, 1);
    assert.match(add.json.errors[0], /private/);
    const mine = (await u.req('GET', '/api/portal/proxies')).json;
    assert.equal(mine.proxies.length, 1);
    assert.equal(mine.proxies[0].password, undefined, 'password never returned');
    assert.ok((await u.req('GET', '/api/portal/pools')).json.some((p) => p.personal && p.name === 'My proxies'));

    // another user can neither see nor delete it, nor use the assigned pool
    const other = client();
    await other.req('GET', '/login');
    await other.req('POST', '/api/auth/login', { username: 'signup3', password: 'signuppass3' });
    assert.equal((await other.req('DELETE', `/api/portal/proxies/${mine.proxies[0].id}`)).status, 404);
    assert.equal((await other.req('POST', '/api/portal/browse', { url: 'example.com', poolId: pool.id })).status, 403);
    assert.ok(!(await other.req('GET', '/api/portal/pools')).json.some((p) => p.name === 'Assigned only'));

    assert.equal((await u.req('DELETE', `/api/portal/proxies/${mine.proxies[0].id}`)).status, 200);
});
