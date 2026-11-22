'use strict';
/**
 * Time zones: the DB keeps UTC; "today" / per-day totals follow the viewer's
 * zone sent in X-Timezone.
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const tz = require('../src/lib/timezone');
const usage = require('../src/services/usage');
const users = require('../src/services/users');
const db = require('../src/db');

test('timezone helpers: offsets, local midnight, DST, odd offsets', () => {
    assert.ok(tz.isValid('Asia/Karachi'));
    assert.ok(!tz.isValid('Mars/Base'));
    assert.ok(!tz.isValid('UTC; DROP TABLE'));
    assert.equal(tz.normalize('nope'), 'UTC');

    const t = Date.UTC(2026, 10, 22, 20, 30); // 22 Nov 20:30 UTC
    assert.equal(tz.offsetMinutes('Asia/Karachi', t), 300);
    assert.equal(tz.offsetMinutes('Asia/Kolkata', t), 330);
    assert.equal(tz.offsetMinutes('Asia/Kathmandu', t), 345);
    assert.equal(tz.offsetLabel('America/New_York', t), '-05:00');
    // 20:30 UTC is already the 23rd in Karachi (01:30)
    assert.equal(tz.dayKey(t, 'Asia/Karachi'), '2026-11-23');
    assert.equal(tz.dayKey(t, 'UTC'), '2026-11-22');
    assert.equal(tz.startOfDay('Asia/Karachi', t), Date.UTC(2026, 10, 22, 19, 0)); // 00:00 PKT = 19:00 UTC the day before
    assert.equal(tz.startOfDay('Asia/Kolkata', t), Date.UTC(2026, 10, 22, 18, 30));
    assert.equal(tz.formatLocal(t, 'Asia/Karachi'), '2026-11-23 01:30:00 +05:00');

    // US DST ends 1 Nov 2026: that local day is 25 hours long
    const nov2 = tz.startOfDay('America/New_York', Date.UTC(2026, 10, 2, 17));
    const nov1 = tz.startOfDayAgo('America/New_York', 1, Date.UTC(2026, 10, 2, 17));
    assert.equal(nov2 - nov1, 25 * 3600000);
});

test('usage: "today" and per-day totals follow the viewer\'s midnight', () => {
    const { user } = users.create({ username: 'tzuser', password: 'password123' });
    const conn = db.get();
    const add = (ms, bytes) => conn.prepare('INSERT INTO usage_slots (user_id, slot, requests, bytes) VALUES (?, ?, 1, ?)').run(user.id, Math.floor(ms / 900000) * 900000, bytes);
    const karachiMidnight = tz.startOfDay('Asia/Karachi');
    add(karachiMidnight + 60000, 1000); // just after Karachi midnight
    add(karachiMidnight - 60000, 500); // just before -> yesterday in Karachi
    assert.equal(usage.bytesToday(user.id, 'Asia/Karachi'), 1000);
    const days = usage.daily(2, 'Asia/Karachi');
    assert.equal(days.length, 2);
    assert.equal(days[1].day, tz.dayKey(Date.now(), 'Asia/Karachi'));
    assert.ok(days[1].bytes >= 1000);
    assert.ok(days[0].bytes >= 500);

    // pending (unflushed) bytes count too
    usage.track(user.id, null, 250);
    assert.equal(usage.bytesToday(user.id, 'Asia/Karachi'), 1250);
    usage.flush();
});

test('users: browser time zone is remembered only when it changes', () => {
    const { user } = users.create({ username: 'tzsaver', password: 'password123' });
    assert.equal(users.setTimezone(user.id, 'Europe/London'), true);
    assert.equal(users.setTimezone(user.id, 'Europe/London'), false);
    assert.equal(users.getById(user.id).timezone, 'Europe/London');
});
