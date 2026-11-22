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
    assert.ok(c.jar.pp_id, 'identity token cookie');
    assert.ok(c.jar.pp_at, 'access token cookie');

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

test('unexpected server error -> 500 with reference; admin sees it with the steps before it', async () => {
    const u = client();
    await u.req('GET', '/login');
    await u.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    await u.req('GET', '/api/portal/sessions'); // a step before the failure

    const sitesService = require('../src/services/sites');
    const original = sitesService.listEnabled;
    sitesService.listEnabled = () => {
        throw new TypeError("Cannot read properties of undefined (reading 'start_url')");
    };
    let res;
    try {
        res = await u.req('GET', '/api/portal/sites');
    } finally {
        sitesService.listEnabled = original;
    }
    assert.equal(res.status, 500);
    assert.match(res.json.ref, /^E-/);
    assert.match(res.json.error, new RegExp(res.json.ref));
    assert.ok(res.headers.get('x-request-id'));

    const admin = client();
    await admin.req('GET', '/login');
    await admin.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const report = (await admin.req('GET', `/api/admin/errors/${res.json.ref}`)).json;
    assert.equal(report.kind, 'server_exception');
    assert.equal(report.request_id, res.headers.get('x-request-id'));
    const steps = report.breadcrumbs.map((c) => `${c.type} ${c.url || c.event}`);
    assert.ok(steps.some((s) => s.includes('/api/portal/sessions')), 'earlier API call is in the trail: ' + steps.join(' | '));
    assert.ok(steps.some((s) => s === 'event login'), 'sign-in event is in the trail');
    assert.ok(report.stack.includes('TypeError'));
    assert.equal(JSON.stringify(report).includes('userpass123'), false, 'no password anywhere');

    // validation problems are NOT error reports
    const before = (await admin.req('GET', '/api/admin/errors?status=all')).json.reports.length;
    await admin.req('POST', '/api/admin/sites', { name: 'x', startUrl: 'nope', domains: 'a.com' });
    assert.equal((await admin.req('GET', '/api/admin/errors?status=all')).json.reports.length, before);
});

test('browser errors are reported with the browser trail; exports work', async () => {
    const u = client();
    await u.req('GET', '/login');
    const r = await u.req('POST', '/api/client-errors', {
        kind: 'client_js',
        message: 'undefined is not a function',
        stack: 'at portal.js:10',
        page: '/',
        crumbs: [{ t: Date.now() - 1000, type: 'click', label: 'Go' }]
    });
    assert.equal(r.status, 200);
    const admin = client();
    await admin.req('GET', '/login');
    await admin.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const report = (await admin.req('GET', `/api/admin/errors/${r.json.ref}`)).json;
    assert.equal(report.source, 'client');
    assert.ok(report.breadcrumbs.some((c) => c.type === 'browser:click' && c.label === 'Go'));

    const csv = await admin.req('GET', '/api/admin/events.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^time_utc,time_local \(UTC\),event,level,source,user_id,username,detail,target,changes,ip,browser,os,device,screen,server,process,release,request_id\n/);
    const jsonl = await admin.req('GET', '/api/admin/errors.jsonl?days=1');
    const lines = jsonl.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.ref === r.json.ref));
});

test('admin can read the request log, a session timeline and server health', async () => {
    const admin = client();
    await admin.req('GET', '/login');
    await admin.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    await admin.req('GET', '/api/admin/overview');
    require('../src/services/requestLog').flush();
    const rows = (await admin.req('GET', '/api/admin/requests?hours=1')).json;
    assert.ok(rows.some((r) => r.source === 'web' && r.url === '/api/admin/overview' && r.status === 200 && r.username === 'admin1'));
    const server = (await admin.req('GET', '/api/admin/server?hours=1')).json;
    assert.ok(Array.isArray(server.series) && Array.isArray(server.processes) && Array.isArray(server.traffic));
    const csv = await admin.req('GET', '/api/admin/requests.csv?hours=1');
    assert.match(csv.text, /^time_utc,time_local \(UTC\),source,kind,username/);
});

test('admin lists: ?paged=1 returns batches + whole-set summary on the first batch only', async () => {
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const events = require('../src/services/events');
    for (let i = 0; i < 7; i++) events.record('paged_api_event', { detail: String(i) });

    const first = await c.req('GET', '/api/admin/events?paged=1&limit=3&type=paged_api_event');
    assert.equal(first.status, 200);
    assert.equal(first.json.items.length, 3);
    assert.ok(first.json.nextCursor);
    assert.equal(first.json.summary.total, 7, 'summary covers every matching row, not just this batch');

    const second = await c.req('GET', `/api/admin/events?paged=1&limit=3&type=paged_api_event&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    assert.equal(second.json.items.length, 3);
    assert.equal(second.json.summary, undefined, 'later batches only add rows');
    assert.ok(second.json.items[0].id < first.json.items[2].id);

    for (const path of ['/api/admin/requests?paged=1', '/api/admin/errors?paged=1&status=all', '/api/admin/users?paged=1', '/api/admin/sessions?paged=1']) {
        const r = await c.req('GET', path);
        assert.equal(r.status, 200, path);
        assert.ok(Array.isArray(r.json.items), path);
        assert.ok(r.json.summary && typeof r.json.summary.total === 'number', path);
        assert.ok('nextCursor' in r.json, path);
    }
    // The plain (unpaged) answer stays an array for pickers and scripts.
    assert.ok(Array.isArray((await c.req('GET', '/api/admin/users')).json));
});

test('X-Timezone: the server uses the browser zone for "today" and remembers it', async () => {
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const r = await c.req('GET', '/api/admin/overview', undefined, { 'x-timezone': 'Asia/Karachi' });
    assert.equal(r.json.timezone, 'Asia/Karachi');
    assert.equal(r.headers.get('x-timezone-used'), 'Asia/Karachi');
    // invalid zones are ignored (falls back to the remembered one)
    const bad = await c.req('GET', '/api/admin/overview', undefined, { 'x-timezone': 'Not/AZone' });
    assert.equal(bad.json.timezone, 'Asia/Karachi');
    // CSV link without headers: ?tz=
    const csv = await c.req('GET', '/api/admin/events.csv?tz=Asia/Kolkata');
    assert.match(csv.text, /^time_utc,time_local \(Asia\/Kolkata\),/);
    assert.match(csv.text, /\+05:30"/);
});

test('admin actions are stored in the activity log with target, changes, device and request id', async () => {
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    const device = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'x-client': JSON.stringify({ screen: '1920x1080', lang: 'en-US', tz: 'UTC' }) };
    const site = await c.req('POST', '/api/admin/sites', { name: 'Audit site', startUrl: 'https://audit.example/', domains: 'audit.example' }, device);
    assert.equal(site.status, 200, JSON.stringify(site.json));
    const upd = await c.req('PUT', `/api/admin/sites/${site.json.id}`, { name: 'Audit site 2', startUrl: 'https://audit.example/', domains: 'audit.example' }, device);
    assert.equal(upd.status, 200);
    const list = await c.req('GET', '/api/admin/events?paged=1&type=admin_site_updated');
    const e = list.json.items[0];
    assert.equal(e.username, 'admin1');
    assert.equal(e.target, `site:${site.json.id}`);
    assert.match(e.detail, /name Audit site -> Audit site 2/);
    assert.equal(e.browser, 'Chrome');
    assert.equal(e.screen, '1920x1080');
    const full = await c.req('GET', `/api/admin/events/${e.id}`);
    assert.deepEqual(full.json.changes.name, ['Audit site', 'Audit site 2']);
    assert.equal(full.json.request_id, upd.headers.get('x-request-id'));
    assert.equal(full.json.client.os, 'Windows');
    // the row itself records who changed it
    const db = require('../src/db');
    const row = db.get().prepare('SELECT created_by, updated_by FROM sites WHERE id = ?').get(site.json.id);
    assert.equal(row.created_by, e.user_id);
    assert.equal(row.updated_by, e.user_id);
    // invalid ids are a 404, not a database error
    assert.equal((await c.req('PUT', '/api/admin/sites/123', { name: 'x' })).status, 404);
});

// ------------------------------------------------------------ JWT sign-in --
test('JWT: access token carries what requests need; expired access is renewed from the identity token', async () => {
    const jwt = require('../src/lib/jwt');
    const users = require('../src/services/users');
    const c = client();
    await c.req('GET', '/login');
    const login = await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    assert.equal(login.status, 200);
    const session = login.json.session;
    assert.ok(session.accessExpiresAt - Date.now() <= 5 * 60000 + 1000, 'access token lives 5 minutes');
    assert.ok(session.identityExpiresAt - Date.now() > 23 * 3600000, 'identity token lives 24 hours');
    const claims = jwt.verify(decodeURIComponent(c.jar.pp_at), { kind: 'access' });
    const u = users.getById(claims.sub);
    assert.equal(claims.name, 'user1');
    assert.equal(claims.role, 'user');
    assert.equal(claims.tv, u.token_version);
    for (const k of ['email', 'pool', 'rpm', 'bw', 'tz', 'sid', 'idx', 'jti', 'iat', 'exp']) assert.ok(k in claims, `claim ${k}`);
    assert.equal(jwt.verify(decodeURIComponent(c.jar.pp_at), { kind: 'identity' }), null, 'an access token is not an identity token');

    // access token expired -> API says so, refresh issues a new one, retry works
    c.jar.pp_at = encodeURIComponent(jwt.sign({ sub: u.id, tv: u.token_version, idx: claims.idx }, { kind: 'access', ttlSec: -5 }).token);
    const denied = await c.req('GET', '/api/portal/sites');
    assert.equal(denied.status, 401);
    assert.equal(denied.json.code, 'access_token_expired');
    const refreshed = await c.req('POST', '/api/auth/refresh');
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
    assert.ok(refreshed.json.session.accessExpiresAt > Date.now());
    assert.equal((await c.req('GET', '/api/portal/sites')).status, 200);

    // page navigation without an access token: renewed silently on the server
    delete c.jar.pp_at;
    const page = await c.req('GET', '/');
    assert.equal(page.status, 200);
    assert.ok(c.jar.pp_at, 'new access cookie set');
});

test('JWT: expired identity token asks for the password again; same user only; tampering rejected', async () => {
    const jwt = require('../src/lib/jwt');
    const users = require('../src/services/users');
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    const u = users.getById(jwt.verify(decodeURIComponent(c.jar.pp_at), { kind: 'access' }).sub);

    // identity expired
    c.jar.pp_id = encodeURIComponent(jwt.sign({ sub: u.id, tv: u.token_version, amr: ['pwd'] }, { kind: 'identity', ttlSec: -5 }).token);
    delete c.jar.pp_at;
    const r = await c.req('POST', '/api/auth/refresh');
    assert.equal(r.status, 401);
    assert.equal(r.json.code, 'identity_expired');
    assert.equal(r.json.username, 'user1', 'the prompt knows whose password to ask for');
    const api = await c.req('GET', '/api/portal/sites');
    assert.equal(api.json.code, 'identity_expired');
    const nav = await c.req('GET', '/proxies');
    assert.equal(nav.status, 302);
    assert.match(nav.headers.get('location'), /^\/login\?next=%2Fproxies&expired=1$/);

    // re-sign-in from the prompt: another account is refused, the same one continues
    const other = await c.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123', continueAs: u.id });
    assert.equal(other.status, 409);
    const same = await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123', continueAs: u.id });
    assert.equal(same.status, 200);
    assert.equal((await c.req('GET', '/api/portal/sites')).status, 200);

    // tampered payload / alg=none are rejected
    const [h, p, s] = decodeURIComponent(c.jar.pp_at).split('.');
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), role: 'admin' })).toString('base64url');
    c.jar.pp_at = encodeURIComponent(`${h}.${evil}.${s}`);
    delete c.jar.pp_id;
    assert.equal((await c.req('GET', '/api/admin/users')).status, 401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    c.jar.pp_at = encodeURIComponent(`${none}.${p}.`);
    assert.equal((await c.req('GET', '/api/portal/sites')).status, 401);
});

test('JWT: "sign out everywhere" revokes tokens that are still within their lifetime', async () => {
    const a = client();
    const b = client();
    for (const c of [a, b]) {
        await c.req('GET', '/login');
        await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    }
    assert.equal((await b.req('GET', '/api/portal/sites')).status, 200);
    await a.req('POST', '/api/auth/logout', { everywhere: true });
    await new Promise((r) => setTimeout(r, 3100)); // user cache TTL
    const r = await b.req('GET', '/api/portal/sites');
    assert.equal(r.status, 401);
    assert.equal((await b.req('POST', '/api/auth/refresh')).json.code, 'not_signed_in');
});

test('browse: words open the search engine results page through the proxy', async () => {
    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    const r = await c.req('POST', '/api/portal/browse', { url: 'best pizza near me' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ticket = readTicket(new URL(r.json.redirect).searchParams.get('t'));
    assert.equal(ticket.url, 'https://www.google.com/search?q=best%20pizza%20near%20me');
    const s = await c.req('GET', '/api/portal/search-suggest?q=example.com');
    assert.equal(s.status, 200);
    assert.equal(s.json.kind, 'url');
    assert.equal(s.json.engine, 'Google');
});

test('performance: versioned assets cached for a year; API answers carry rate-limit headers', async () => {
    const c = client();
    const login = await c.req('GET', '/login');
    const m = /href="(\/assets\/v-[0-9a-f]{8}\/css\/app\.css)"/.exec(login.text);
    assert.ok(m, 'pages reference versioned assets');
    const css = await c.req('GET', m[1]);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('cache-control'), /max-age=31536000.*immutable/);
    assert.equal((await c.req('GET', '/assets/v-00000000/css/app.css')).status, 200, 'old version URLs still serve the file');
    const me = await c.req('GET', '/api/auth/me');
    assert.ok(Number(me.headers.get('ratelimit-limit')) > 0);
    assert.ok(me.headers.get('ratelimit-remaining') !== null);
});

test('rate limiting: too many API calls -> 429 with Retry-After', async () => {
    process.env.API_RATE_LIMIT_ANON_RPM = '5';
    try {
        const c = client();
        let last;
        for (let i = 0; i < 7; i++) last = await c.req('GET', '/api/auth/me', undefined, { 'x-forwarded-for': '198.51.100.77' });
        assert.equal(last.status, 429);
        assert.equal(last.json.code, 'rate_limited');
        assert.ok(Number(last.headers.get('retry-after')) > 0);
    } finally {
        delete process.env.API_RATE_LIMIT_ANON_RPM;
    }
});

test('session proxy: user sees and switches the proxy of their own session; rules enforced; logged', async () => {
    const users = require('../src/services/users');
    const pools = require('../src/services/pools');
    const sessions = require('../src/services/sessions');
    const db = require('../src/db');
    const u1 = users.getById(db.get().prepare("SELECT id FROM users WHERE username = 'user1'").get().id);
    const pool = pools.savePool({ name: 'Switch pool', visibility: 'all' });
    pools.importProxies(pool.id, '198.51.100.21:8080:alice-ES-1:pw\n198.51.100.22:8080:alice-ES-2:pw\n198.51.100.23:8080', 'http');
    const [a, b, dead] = pools.listProxies(pool.id);
    for (const x of [a, b]) pools.recordHealth(x.id, { ok: true, latencyMs: 500, slowMs: 5000, failuresBeforeDead: 3 });
    for (let i = 0; i < 3; i++) pools.recordHealth(dead.id, { ok: false, error: 'refused', slowMs: 5000, failuresBeforeDead: 3 });
    const sid = 'c'.repeat(32);
    sessions.create({ id: sid, userId: u1.id, poolId: pool.id, proxyId: a.id, startUrl: 'https://example.org/' });

    const c = client();
    await c.req('GET', '/login');
    await c.req('POST', '/api/auth/login', { username: 'user1', password: 'userpass123' });
    const list = await c.req('GET', '/api/portal/sessions');
    const mine = list.json.find((s) => s.id === sid);
    assert.equal(mine.proxy_username, 'alice-ES-1');
    assert.equal(mine.proxy_host, '198.51.100.21');

    const choices = await c.req('GET', `/api/portal/sessions/${sid}/proxies`);
    const opts = choices.json.pools.find((p) => p.id === pool.id).proxies;
    assert.equal(opts.find((x) => x.id === a.id).current, true);
    assert.equal(opts.find((x) => x.id === dead.id).usable, false);
    assert.ok(opts.every((x) => !('password' in x)), 'no passwords sent to the browser');

    assert.equal((await c.req('POST', `/api/portal/sessions/${sid}/proxy`, { proxyId: dead.id })).status, 400, 'offline proxy refused');
    const ok = await c.req('POST', `/api/portal/sessions/${sid}/proxy`, { proxyId: b.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.proxy, 'alice-ES-2 @ 198.51.100.22:8080');
    assert.equal(sessions.get(sid).proxy_id, b.id);
    const e = db.get().prepare("SELECT * FROM events WHERE type = 'session_proxy_changed' ORDER BY id DESC LIMIT 1").get();
    assert.match(e.detail, /alice-ES-1 @ 198\.51\.100\.21:8080 -> alice-ES-2 @ 198\.51\.100\.22:8080/);
    assert.equal(e.target, `session:${sid}`);

    // someone else's session: not found
    const other = client();
    await other.req('GET', '/login');
    await other.req('POST', '/api/auth/login', { username: 'admin1', password: 'adminpass123' });
    assert.equal((await other.req('POST', `/api/portal/sessions/${sid}/proxy`, { proxyId: a.id })).status, 404);
    // admin can switch it from Admin -> Sessions
    const adm = await other.req('POST', `/api/admin/sessions/${sid}/proxy`, { proxyId: a.id });
    assert.equal(adm.status, 200, JSON.stringify(adm.json));
    assert.equal(sessions.get(sid).proxy_id, a.id);
    sessions.markEnded(sid, 'test');
});
