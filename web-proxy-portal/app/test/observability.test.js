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

test('request log: levels, batching, filters, session timeline', () => {
    const requestLog = require('../src/services/requestLog');
    process.env.REQUEST_LOG_LEVEL = 'pages';
    assert.equal(requestLog.wanted('page', 200), true);
    assert.equal(requestLog.wanted('resource', 200), false, 'successful images/scripts skipped by default');
    assert.equal(requestLog.wanted('resource', 404), true, 'failures always kept');
    process.env.REQUEST_LOG_LEVEL = 'off';
    assert.equal(requestLog.wanted('page', 200), false);
    assert.equal(requestLog.wanted('page', 0), true);
    process.env.REQUEST_LOG_LEVEL = 'pages';

    const sid = 'r'.repeat(32);
    requestLog.add({ source: 'proxy', kind: 'page', sessionId: sid, method: 'GET', url: 'https://shop.example/?password=x', host: 'shop.example', status: 200, ms: 120, bytes: 5000 });
    requestLog.add({ source: 'proxy', kind: 'resource', sessionId: sid, method: 'GET', url: 'https://cdn.example/a.png', host: 'cdn.example', status: 200, ms: 5 });
    requestLog.add({ source: 'proxy', kind: 'page', sessionId: sid, method: 'GET', url: 'https://shop.example/cart', host: 'shop.example', status: 0, error: 'reset' });
    assert.equal(requestLog.list({ sessionId: sid }).length, 0, 'buffered, not yet written');
    requestLog.flush();
    const rows = requestLog.sessionTimeline(sid);
    assert.deepEqual(rows.map((r) => r.status), [200, 0]);
    assert.ok(!rows[0].url.includes('password=x'), 'urls redacted');
    assert.equal(requestLog.list({ sessionId: sid, status: 'failed' }).length, 1);
    assert.equal(requestLog.list({ q: 'cart' }).length, 1);
});

test('metrics: samples per process; unclean previous exit is detected', () => {
    const metrics = require('../src/services/metrics');
    const db = require('../src/db');
    // a previous instance that "started" but never stopped and whose pid is gone
    events.record('process_start', { detail: 'unit:0 pid 999999 release x node v' });
    metrics.start('unit:0');
    metrics.observe(200, 40);
    metrics.observe(502, 900);
    const row = metrics.sample();
    assert.equal(row.process, 'unit:0');
    assert.equal(row.requests, 2);
    assert.equal(row.errors, 1);
    assert.ok(row.rss_mb > 0 && row.p95_ms >= 40);
    const types = db.get().prepare("SELECT type FROM events WHERE type LIKE 'process_%' ORDER BY id").all().map((r) => r.type);
    assert.ok(types.includes('process_unclean_exit'), types.join(','));
    metrics.stop('test');
    assert.equal(db.get().prepare("SELECT type FROM events ORDER BY id DESC LIMIT 1").get().type, 'process_stop');
    assert.ok(metrics.series(1).some((m) => m.process === 'unit:0'));
});

test('request log: "User activity" hides background reads but keeps actions and failures', () => {
    const requestLog = require('../src/services/requestLog');
    const uid = require('../src/lib/ids').newId();
    requestLog.add({ source: 'web', kind: 'api', userId: uid, method: 'GET', url: '/api/portal/sessions', status: 200 });
    requestLog.add({ source: 'web', kind: 'api', userId: uid, method: 'POST', url: '/api/portal/browse', status: 200 });
    requestLog.add({ source: 'web', kind: 'api', userId: uid, method: 'GET', url: '/api/portal/sites', status: 500 });
    requestLog.add({ source: 'proxy', kind: 'page', userId: uid, method: 'GET', url: 'https://a.example/', status: 200 });
    requestLog.flush();
    const urls = requestLog.list({ userId: uid, kind: 'activity' }).map((r) => r.url).sort();
    assert.deepEqual(urls, ['/api/portal/browse', '/api/portal/sites', 'https://a.example/']);
    assert.equal(requestLog.list({ userId: uid }).length, 4, 'everything is still available');
});
