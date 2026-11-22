'use strict';
/**
 * Tests the proxy request guard with a fake Rammerhead (no engine needed).
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const users = require('../src/services/users');
const sessions = require('../src/services/sessions');
const settings = require('../src/services/settings');
const { mintProxy, COOKIE_PROXY } = require('../src/lib/authTokens');
const { createGuard } = require('../src/proxy/guard');

// ---- fake rammerhead pieces ----
const fakeRh = {
    getSessionId: (p) => ((p || '').match(/^(?:[a-z0-9]+:\/\/[^/]+)?\/([a-z0-9]{32})/i) || [])[1],
    StrShuffler: class {
        unshuffle(s) {
            return s;
        }
    },
    cacheTag: { strip: (u) => u }
};
const store = new Map();
const sessionStore = {
    get: (id) => store.get(id),
    has: (id) => store.has(id),
    delete: (id) => store.delete(id)
};
const guard = createGuard({ rh: fakeRh, sessionStore });

function fakeReq(url, { cookie, headers = {} } = {}) {
    return { url, method: 'GET', headers: { ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: '198.51.100.7' } };
}
function fakeRes() {
    const res = { status: null, headers: {}, body: '', headersSent: false, listeners: {} };
    res.writeHead = (s, h) => {
        res.status = s;
        Object.assign(res.headers, h);
        res.headersSent = true;
    };
    res.end = (b) => {
        if (b) res.body += b;
    };
    res.write = () => true;
    res.once = (ev, fn) => (res.listeners[ev] = fn);
    return res;
}

let alice;
let bob;
const SID = 'a1'.repeat(16);

test.before(() => {
    settings.update({ upstream_fallback: 'direct' }); // no proxies configured in this test
    alice = users.create({ username: 'g-alice', password: 'password123' }).user;
    bob = users.create({ username: 'g-bob', password: 'password123' }).user;
    sessions.create({ id: SID, userId: alice.id });
    store.set(SID, { data: {}, injectable: { scripts: [] } });
});

const cookieFor = (u) => `${COOKIE_PROXY}=${mintProxy(u).token}; other=1`;

test('public paths pass without a cookie', async () => {
    assert.equal(await guard(fakeReq('/__portal/start?t=x'), fakeRes(), {}, true, false), false);
});

test('no cookie: navigation is redirected to portal login, sub-request gets 401', async () => {
    const nav = fakeRes();
    assert.equal(await guard(fakeReq(`/${SID}/https://example.com/`, { headers: { 'sec-fetch-dest': 'document' } }), nav, {}, false, false), true);
    assert.equal(nav.status, 302);
    assert.equal(nav.headers.Location, 'https://portal.test/login');
    const sub = fakeRes();
    await guard(fakeReq(`/${SID}!s/https://example.com/a.js`, { headers: { 'sec-fetch-dest': 'script' } }), sub, {}, false, false);
    assert.equal(sub.status, 401);
});

test('other user cannot use someone else\'s session', async () => {
    const res = fakeRes();
    await guard(fakeReq(`/${SID}/https://example.com/`, { cookie: cookieFor(bob) }), res, {}, false, false);
    assert.equal(res.status, 403);
});

test('owner passes; own cookie and IP-revealing headers are stripped', async () => {
    const req = fakeReq(`/${SID}/https://example.com/`, { cookie: cookieFor(alice), headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' } });
    const res = fakeRes();
    assert.equal(await guard(req, res, {}, false, false), false);
    assert.equal(req.headers['x-forwarded-for'], undefined);
    assert.equal(req.headers['x-real-ip'], undefined);
    assert.equal(req.headers.cookie, 'other=1');
    assert.equal(req.portalClientIp, '1.2.3.4', 'real client IP captured before the header was stripped');
});

test('allowlist blocks navigations to other domains but not sub-resources (non-strict)', async () => {
    settings.update({ allowlist_enabled: true, allowlist_extra: 'allowed.com' });
    const blocked = fakeRes();
    await guard(fakeReq(`/${SID}/https://evil.com/`, { cookie: cookieFor(alice), headers: { 'sec-fetch-dest': 'document' } }), blocked, {}, false, false);
    assert.equal(blocked.status, 403);
    const img = fakeRes();
    assert.equal(await guard(fakeReq(`/${SID}/https://cdn.other.com/x.png`, { cookie: cookieFor(alice), headers: { 'sec-fetch-dest': 'image' } }), img, {}, false, false), false);
    const ok = fakeRes();
    assert.equal(await guard(fakeReq(`/${SID}/https://allowed.com/`, { cookie: cookieFor(alice), headers: { 'sec-fetch-dest': 'document' } }), ok, {}, false, false), false);
    settings.update({ allowlist_enabled: false });
});

test('rate limit returns 429', async () => {
    users.update(alice.id, { rateLimitRpm: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) {
        const res = fakeRes();
        await guard(fakeReq(`/${SID}/https://example.com/${i}`, { cookie: cookieFor(users.getById(alice.id)) }), res, {}, false, false);
        results.push(res.status);
    }
    assert.ok(results.includes(429), JSON.stringify(results));
    users.update(alice.id, { rateLimitRpm: '' });
});

test('ended session is refused and removed from the store', async () => {
    sessions.requestEnd(SID);
    const res = fakeRes();
    const u = users.getById(alice.id);
    await guard(fakeReq(`/${SID}/https://example.com/`, { cookie: cookieFor(u), headers: { 'sec-fetch-dest': 'document' } }), res, {}, false, false);
    assert.equal(res.status, 410);
    assert.equal(store.has(SID), false);
});
