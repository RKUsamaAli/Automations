'use strict';
/** Type-ahead suggestions: prefix matches first, LIKE wildcards are literal, limits respected. */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const suggest = require('../src/services/suggest');
const users = require('../src/services/users');
const sites = require('../src/services/sites');
const pools = require('../src/services/pools');
const sessions = require('../src/services/sessions');
const requestLog = require('../src/services/requestLog');

test('users: prefix matches first, e-mail matches too, wildcards are literal', () => {
    users.create({ username: 'kalani', password: 'password123' });
    users.create({ username: 'alice', password: 'password123', email: 'alice@example.com' });
    users.create({ username: 'bob', password: 'password123', email: 'bob@alpha.test' });
    const r = suggest.users('al');
    assert.deepEqual(r.slice(0, 1).map((u) => u.value), ['alice'], 'prefix match first');
    assert.ok(r.some((u) => u.value === 'kalani'));
    assert.ok(r.some((u) => u.value === 'bob'), 'matched by e-mail');
    assert.equal(suggest.users('%').length, 0, '% is not a wildcard');
    assert.equal(suggest.users('', { limit: 2 }).length, 2);
    assert.ok(r[0].id, 'carries the id for filtering');
});

test('hosts, domain patterns, proxy hosts, recent pages', () => {
    sites.save({ name: 'Demo shop', startUrl: 'https://www.shop.example/', domains: '*.shop.example' });
    requestLog.add({ source: 'proxy', kind: 'page', url: 'https://news.example.org/a', host: 'news.example.org', status: 200 });
    requestLog.flush();
    const h = suggest.hosts('');
    assert.ok(h.find((x) => x.value === 'www.shop.example' && /Site/.test(x.hint)));
    assert.ok(h.find((x) => x.value === 'news.example.org'));
    assert.deepEqual(suggest.hosts('news').map((x) => x.value), ['news.example.org']);

    const d = suggest.domainPatterns('news');
    assert.deepEqual(d.map((x) => x.value), ['*.example.org', 'news.example.org']);
    assert.deepEqual(suggest.domainPatterns('*.news').map((x) => x.value)[0], '*.example.org', 'a typed "*." still matches');

    const pool = pools.savePool({ name: 'Suggest pool' });
    pools.importProxies(pool.id, '198.51.100.7:8080\n198.51.100.7:8081\n198.51.100.9:8080', 'http');
    const ph = suggest.proxyHosts(pool.id, '100.7');
    assert.equal(ph.length, 1);
    assert.equal(ph[0].hint, '2 ports');

    const u = users.create({ username: 'recentuser', password: 'password123' }).user;
    sessions.create({ id: 'rs1', userId: u.id, startUrl: 'https://www.wikipedia.org/' });
    sessions.create({ id: 'rs2', userId: u.id, startUrl: 'https://www.wikipedia.org/' });
    sessions.create({ id: 'rs3', userId: u.id, startUrl: 'https://example.com/x' });
    const recent = suggest.recentUrls(u.id, '');
    assert.equal(recent.length, 2, 'one entry per site');
    assert.deepEqual(suggest.recentUrls(u.id, 'wiki').map((x) => x.label), ['wikipedia.org']);
});
