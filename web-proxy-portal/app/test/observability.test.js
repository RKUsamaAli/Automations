'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactUrl, redactObject, safeHeaders, redactText } = require('../src/lib/redact');
const Breadcrumbs = require('../src/lib/breadcrumbs');
const errorReports = require('../src/services/errorReports');
const users = require('../src/services/users');
const events = require('../src/services/events');
const { isBug } = require('../src/lib/errors');

test('redaction: secrets never reach logs or reports', () => {
    assert.equal(redactUrl('https://bob:hunter2@site.com/login?password=x&q=shoes&keyword=red'), 'https://site.com/login?password=%5Bredacted%5D&q=shoes&keyword=red');
    assert.match(redactUrl('/__portal/start?t=abc.def'), /t=%5Bredacted%5D/);
    assert.equal(redactUrl('/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6/https://x.com/'), '/a1b2c3d4…/https://x.com/', 'session ids shortened');
    assert.deepEqual(redactObject({ username: 'a', password: 'p', nested: { accessToken: 'z', ok: 1 } }), { username: 'a', password: '[redacted]', nested: { accessToken: '[redacted]', ok: 1 } });
    assert.deepEqual(redactObject({ t: 123, type: 'page' }), { t: 123, type: 'page' }, 'trail timestamps survive (regression: E-FWWFZ7)');
    const h = safeHeaders({ cookie: 'pp_login=x', authorization: 'Basic x', 'user-agent': 'UA', 'x-csrf-token': 't' });
    assert.deepEqual(h, { 'user-agent': 'UA' });
    assert.equal(redactText('connect to http://user:secret@1.2.3.4:8080 failed'), 'connect to http://user:***@1.2.3.4:8080 failed');
});

test('breadcrumbs: bounded ring per key', () => {
    const b = new Breadcrumbs({ size: 3 });
    for (let i = 1; i <= 5; i++) b.add('k', { n: i });
    assert.deepEqual(b.get('k').map((c) => c.n), [3, 4, 5]);
    assert.deepEqual(b.get('other'), []);
});

test('isBug separates bugs from validation messages', () => {
    assert.equal(isBug(new Error('Username already exists')), false);
    assert.equal(isBug(new TypeError('x is undefined')), true);
    assert.equal(isBug(Object.assign(new Error('disk I/O'), { code: 'SQLITE_IOERR' })), true);
});

test('error reports: trail + recent events, dedupe, grouping, resolve', () => {
    const u = users.create({ username: 'erruser', password: 'password123' }).user;
    events.record('login', { userId: u.id, detail: 'password' });
    const ref = errorReports.report({
        source: 'proxy',
        kind: 'page_load_failed',
        error: new Error('connect ECONNREFUSED 10.0.0.1:8080 via http://pu:secret@10.0.0.1:8080'),
        userId: u.id,
        sessionId: 's'.repeat(32),
        url: 'https://shop.example/login?password=x',
        destHost: 'shop.example',
        breadcrumbs: [{ t: Date.now() + 1000, type: 'page', url: 'https://shop.example/', status: 200 }]
    });
    assert.match(ref, /^E-[2-9A-HJ-NP-Z]{6}$/);
    const r = errorReports.get(ref);
    assert.equal(r.username, 'erruser');
    assert.ok(!r.message.includes('secret'), 'credentials masked in message');
    assert.ok(!r.url.includes('password=x'), 'url redacted');
    assert.deepEqual(r.breadcrumbs.map((c) => c.type), ['event', 'page'], 'portal events + request trail, in time order');
    assert.ok(r.breadcrumbs.every((c) => typeof c.t === 'number'), 'every step keeps its timestamp');

    // same error again for the same session -> counted, same reference
    const again = errorReports.report({ source: 'proxy', kind: 'page_load_failed', error: 'connect ECONNREFUSED 10.0.0.1:8081 via http://pu:other@10.0.0.1:8081', userId: u.id, sessionId: 's'.repeat(32), destHost: 'shop.example' });
    assert.equal(again, ref);
    assert.equal(errorReports.get(ref).occurrences, 2);

    // another user, same problem -> new report, same group
    const other = errorReports.report({ source: 'proxy', kind: 'page_load_failed', error: 'connect ECONNREFUSED 10.0.0.9:9999 via http://pu:x@10.0.0.9:9999', destHost: 'shop.example' });
    assert.notEqual(other, ref);
    const listed = errorReports.list({ q: 'shop.example' });
    assert.ok(listed.every((x) => x.group_count === 2));
    assert.equal(errorReports.resolveGroup(r.fingerprint, u.id), 2);
    assert.equal(errorReports.list({ status: 'open', q: 'shop.example' }).length, 0);
});
