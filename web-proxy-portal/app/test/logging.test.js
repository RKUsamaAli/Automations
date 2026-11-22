'use strict';
/**
 * Action logging: every action stored (who, what, target, changes, device,
 * server); devices parsed and stored once; system logs go to files.
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ua = require('../src/lib/userAgent');
const { diff, describe } = require('../src/lib/audit');
const clientDevices = require('../src/services/clientDevices');
const events = require('../src/services/events');
const context = require('../src/lib/context');
const ids = require('../src/lib/ids');

test('user agent parsing: iPhone Safari, Android Chrome, Windows Edge, bots', () => {
    const iphone = ua.parse('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
    assert.equal(iphone.browser, 'Safari');
    assert.equal(iphone.os, 'iOS');
    assert.equal(iphone.osVersion, '17.4');
    assert.equal(iphone.deviceType, 'mobile');
    assert.equal(iphone.engine, 'WebKit');
    const android = ua.parse('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36');
    assert.equal(android.browser, 'Chrome');
    assert.equal(android.browserVersion, '131.0');
    assert.equal(android.os, 'Android');
    assert.equal(android.deviceModel, 'SM-S918B');
    const edge = ua.parse('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51');
    assert.equal(edge.browser, 'Edge');
    assert.equal(edge.os, 'Windows');
    assert.equal(edge.deviceType, 'desktop');
    assert.equal(ua.parse('curl/8.5.0').deviceType, 'bot');
    const ipadOs = ua.parse('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    assert.equal(ipadOs.deviceType, 'tablet');
});

test('client devices: stored once, with screen/language/zone from X-Client', () => {
    const req = {
        headers: {
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
            'x-client': JSON.stringify({ screen: '390x844', vp: '390x664', dpr: 3, lang: 'en-GB', langs: 'en-GB,en', tz: 'Asia/Karachi', touch: true, net: '4g' })
        }
    };
    const a = clientDevices.fromRequest(req);
    const b = clientDevices.fromRequest(req);
    assert.ok(ids.isId(a));
    assert.equal(a, b, 'same device -> same row');
    const d = clientDevices.get(a);
    assert.equal(d.os, 'iOS');
    assert.equal(d.screen, '390x844');
    assert.equal(d.pixel_ratio, 3);
    assert.equal(d.timezone, 'Asia/Karachi');
    assert.equal(d.touch, 1);
    assert.equal(d.last_network, '4g');
    assert.match(clientDevices.describe(d), /Safari 17.4 · iOS 17.4 · iPhone · mobile · 390x844/);
    // junk header is ignored, never an error
    assert.ok(clientDevices.fromRequest({ headers: { 'user-agent': 'x', 'x-client': '{bad json' } }));
    assert.equal(clientDevices.fromRequest({ headers: {} }), null);
});

test('audit diff: only changed fields, secrets masked', () => {
    const changes = diff({ role: 'user', enabled: 1, note: null, password: 'a' }, { role: 'admin', enabled: true, note: '', password: 'b' }, ['role', 'enabled', 'note', 'password']);
    assert.deepEqual(changes, { role: ['user', 'admin'], password: ['***', 'changed'] });
    assert.equal(describe(changes), 'role user -> admin, password changed');
});

test('events: who / request / device / server come from the request context', () => {
    const userId = ids.newId();
    context.run({ userId, requestId: 'req-ctx-1', ip: '203.0.113.9', clientId: null, source: 'web' }, () => {
        events.record('test_action', { detail: 'did something', target: 'site:x', changes: { name: ['a', 'b'] } });
    });
    const e = events.list({ type: 'test_action' })[0];
    assert.equal(e.created_by, userId);
    assert.equal(e.request_id, 'req-ctx-1');
    assert.equal(e.ip, '203.0.113.9');
    assert.equal(e.source, 'web');
    assert.equal(e.server, os.hostname());
    assert.ok(e.process);
    assert.deepEqual(JSON.parse(e.changes), { name: ['a', 'b'] });
    assert.ok(ids.isId(e.id));
});

test('system logs are written to daily JSON files and pruned', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-logs-'));
    process.env.LOG_DIR = dir;
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const write = process.stdout.write;
    process.stdout.write = () => true; // keep test output clean
    try {
        const logger = require('../src/lib/logger');
        logger('test').info('file line', { requestId: 'abc-123' });
        process.stdout.write = write;
        await new Promise((resolve) => setTimeout(resolve, 100)); // the file stream opens asynchronously
        const day = new Date().toISOString().slice(0, 10);
        const file = fs.readdirSync(dir).find((f) => f.startsWith(day));
        assert.ok(file, 'a file for today');
        const line = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').pop());
        assert.equal(line.msg, 'file line');
        assert.equal(line.requestId, 'abc-123');
        assert.equal(line.server, os.hostname());
        fs.writeFileSync(path.join(dir, '2000-01-01.web-0.log'), 'old\n');
        assert.equal(logger.pruneFiles(14), 1);
        assert.ok(!fs.existsSync(path.join(dir, '2000-01-01.web-0.log')));
    } finally {
        process.stdout.write = write;
        process.env.LOG_LEVEL = prevLevel;
        delete process.env.LOG_DIR;
    }
});
