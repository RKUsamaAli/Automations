'use strict';
/**
 * Lazy loading: every paged list must return each row exactly once across
 * batches (no duplicates, no gaps) and its summary must describe the WHOLE
 * filtered set, not just the first batch.
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const paging = require('../src/lib/paging');
const requestLog = require('../src/services/requestLog');
const events = require('../src/services/events');
const errorReports = require('../src/services/errorReports');
const users = require('../src/services/users');
const pools = require('../src/services/pools');
const sessions = require('../src/services/sessions');
const db = require('../src/db');

/** Walks every batch of `pageFn` and returns all items in order. */
function walk(pageFn, limit) {
    const all = [];
    let cursor = null;
    let batches = 0;
    do {
        const p = pageFn({ cursor, limit });
        assert.ok(p.items.length <= limit, 'batch never exceeds the limit');
        all.push(...p.items);
        cursor = p.nextCursor;
        batches += 1;
        assert.ok(batches < 1000, 'terminates');
    } while (cursor);
    return { all, batches };
}
const unique = (list, key) => new Set(list.map(key)).size === list.length;

test('paging helpers: limits and cursors', () => {
    assert.equal(paging.limitOf(undefined), 50);
    assert.equal(paging.limitOf('10'), 10);
    assert.equal(paging.limitOf(99999), 200);
    assert.equal(paging.limitOf(-3), 50);
    assert.deepEqual(paging.decodeCursor(paging.encodeCursor([5, 'a'])), [5, 'a']);
    assert.equal(paging.decodeCursor('not-a-cursor!!'), null);
    assert.equal(paging.decodeCursor(Buffer.from('{"x":1}').toString('base64url')), null, 'only arrays are cursors');
});

test('request log: batches cover the filtered set exactly once; summary is the whole set', () => {
    const { user } = users.create({ username: 'pager1', password: 'password123' });
    const now = Date.now();
    for (let i = 0; i < 137; i++) {
        requestLog.add({ source: 'proxy', kind: 'page', userId: user.id, sessionId: 'sess-page', method: 'GET', url: `https://shop.example/p/${i}`, host: 'shop.example', status: i % 10 === 0 ? 502 : 200, ms: 100, bytes: 1000 });
    }
    requestLog.flush();
    const f = { userId: user.id, kind: 'page' };
    const { all, batches } = walk((o) => requestLog.page(f, o), 50);
    assert.equal(all.length, 137);
    assert.equal(batches, 3);
    assert.ok(unique(all, (r) => r.id), 'no duplicates');
    assert.ok(all.every((r, i) => i === 0 || all[i - 1].id > r.id), 'newest first');

    const s = requestLog.pageSummary(f);
    assert.equal(s.total, 137);
    assert.equal(s.failed, 14);
    assert.equal(s.ok, 123);
    assert.equal(s.bytes, 137000);
    assert.equal(s.avgMs, 100);
    assert.equal(s.users, 1);

    // Rows arriving while the user scrolls do not shift later batches.
    const first = requestLog.page(f, { limit: 50 });
    requestLog.add({ source: 'proxy', kind: 'page', userId: user.id, sessionId: 'sess-page', method: 'GET', url: 'https://shop.example/new', host: 'shop.example', status: 200, ms: 1 });
    requestLog.flush();
    const second = requestLog.page(f, { cursor: first.nextCursor, limit: 50 });
    const ordered = requestLog.list({ ...f, limit: 2000 }).filter((r) => r.url !== 'https://shop.example/new');
    assert.equal(second.items[0].id, ordered[50].id, 'continues right after the last row seen');

    // Filters apply to both the batches and the summary.
    assert.equal(requestLog.pageSummary({ ...f, status: 'failed' }).total, 14);
    assert.equal(walk((o) => requestLog.page({ ...f, status: 'failed' }, o), 5).all.length, 14);

    // Session timeline.
    const tl = walk((o) => requestLog.sessionTimelinePage('sess-page', o), 40);
    assert.equal(tl.all.length, 138);
    assert.equal(requestLog.sessionTimelineSummary('sess-page').pages, 138);
});

test('events, errors, users, proxies, sessions: paged without gaps', () => {
    for (let i = 0; i < 75; i++) events.record('pager_event', { detail: 'n' + i });
    const ev = walk((o) => events.page({ type: 'pager_event' }, o), 20);
    assert.equal(ev.all.length, 75);
    assert.ok(unique(ev.all, (e) => e.id));
    assert.equal(events.pageSummary({ type: 'pager_event' }).total, 75);

    // Error reports share last_seen_at values -> the (last_seen_at, id) cursor must not skip ties.
    const conn = db.get();
    const t = Date.now();
    for (let i = 0; i < 64; i++) {
        db.insert('error_reports', { ref: 'E-PG' + String(i).padStart(4, '0'), last_seen_at: t - (i % 4) * 1000, source: 'proxy', kind: 'site_error', severity: i % 3 ? 'error' : 'warning', fingerprint: 'fp-' + (i % 8), message: 'boom' });
    }
    const er = walk((o) => errorReports.page({ status: 'all', q: 'E-PG' }, o), 10);
    assert.equal(er.all.length, 64);
    assert.ok(unique(er.all, (r) => r.id), 'ties on last_seen_at are not repeated');
    const es = errorReports.pageSummary({ status: 'all', q: 'E-PG' });
    assert.equal(es.total, 64);
    assert.equal(es.problems, 8);
    assert.equal(es.errors + es.warnings, 64);

    // Users: alphabetical, case-insensitive; pending listed separately.
    for (let i = 0; i < 33; i++) users.create({ username: (i % 2 ? 'Zed' : 'amy') + String(i).padStart(2, '0'), password: 'password123' });
    const us = walk((o) => users.page({}, o), 7);
    assert.equal(us.all.length, users.list().filter((u) => !u.pending).length);
    assert.ok(unique(us.all, (u) => u.id));
    const names = us.all.map((u) => u.username.toLowerCase());
    assert.deepEqual(names, [...names].sort(), 'A-Z regardless of case');
    assert.equal(users.pageSummary().total, users.count());

    // Proxies in a pool.
    const pool = pools.savePool({ name: 'Paged pool' });
    const lines = Array.from({ length: 120 }, (_, i) => `203.0.113.${(i % 250) + 1}:${10000 + i}`).join('\n');
    pools.importProxies(pool.id, lines, 'http');
    const px = walk((o) => pools.pageProxies(pool.id, {}, o), 50);
    assert.equal(px.all.length, 120);
    assert.ok(unique(px.all, (x) => x.id));
    const ps = pools.proxySummary(pool.id);
    assert.equal(ps.total, 120);
    assert.equal(ps.unknown, 120);
    assert.equal(walk((o) => pools.pageProxies(pool.id, { status: 'unknown' }, o), 50).all.length, ps.unknown, 'status filter matches the summary bucket');

    // Active sessions.
    const owner = users.create({ username: 'sessowner', password: 'password123' }).user;
    for (let i = 0; i < 23; i++) sessions.create({ id: 'paged-sess-' + i, userId: owner.id, startUrl: 'https://example.com/' });
    const ss = walk((o) => sessions.pageActive(o), 5);
    assert.equal(ss.all.length, sessions.activeSummary().total);
    assert.ok(unique(ss.all, (x) => x.id));
});
