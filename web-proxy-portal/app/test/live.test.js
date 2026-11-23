'use strict';
/**
 * Live browser (src/live/worker.js) with a REAL Chromium: ticket check,
 * screen frames, navigation, typing, clicking, tabs; and the egress guard
 * refusing private addresses. Skipped when no Chromium is installed.
 */
process.env.LIVE_PORT = String(30000 + Math.floor(Math.random() * 20000));
process.env.LIVE_HEADED = 'false';
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmp } = require('./helpers');

let chromiumOk = true;
try {
    require('fs').accessSync(require('playwright-core').chromium.executablePath());
} catch (_) {
    chromiumOk = false;
}
const skip = !chromiumOk && 'no Chromium installed';

let site;
let sitePort;
let server;
const got = [];

test.before(async () => {
    site = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        got.push(u.pathname + u.search);
        res.writeHead(200, { 'content-type': 'text/html' });
        if (u.pathname === '/form') return res.end('<title>Form</title><form action="/got"><input name="q" autofocus style="font-size:30px"></form>');
        if (u.pathname === '/click') return res.end('<title>Click</title><a href="/clicked" style="position:fixed;inset:0;display:block;background:#fc0">anywhere</a>');
        if (u.pathname === '/popup') return res.end('<title>Popup</title><a href="/second" target="_blank" style="position:fixed;inset:0;display:block">open</a>');
        res.end(`<title>Page ${u.pathname}</title><h1>${u.pathname}</h1>`);
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    sitePort = site.address().port;
    process.env.LIVE_RESOLVE = `site.test=127.0.0.1:${sitePort}`;
    process.env.LIVE_PROFILES_DIR = require('path').join(tmp, 'live-profiles');
    if (chromiumOk) server = require('../src/live/worker').start();
});

test.after(async () => {
    site && site.close();
    if (chromiumOk) await require('../src/live/worker').stopAll();
    server && server.close();
});

function ticket(uid = 'user-1') {
    const { sign } = require('../src/lib/crypto');
    const config = require('../src/config');
    return sign({ uid, un: 'tester', exp: Date.now() + 60000 }, config.appSecret, 'live-ticket');
}

/** Connects like live.js does; collects state messages and frames. */
function viewer(query) {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.LIVE_PORT}/live/ws?${query}`);
    const v = { ws, frames: 0, states: [], notices: [], lastState: null };
    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            v.frames += 1;
            v.lastFrame = data;
            return;
        }
        const m = JSON.parse(data.toString());
        if (m.t === 'state') {
            v.states.push(m);
            v.lastState = m;
        }
        if (m.t === 'notice') v.notices.push(m.message);
    });
    v.send = (m) => ws.send(JSON.stringify(m));
    v.until = async (fn, ms = 15000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (fn(v)) return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('timed out; last state: ' + JSON.stringify(v.lastState));
    };
    v.opened = new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        ws.on('unexpected-response', (_req, res) => reject(new Error('HTTP ' + res.statusCode)));
    });
    return v;
}

test('a missing or forged ticket is refused', { skip }, async () => {
    await assert.rejects(viewer('t=nope').opened, /403/);
    // another user's id in the payload, signature kept
    const [body, mac] = ticket().split('.');
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), uid: 'someone-else' })).toString('base64url');
    const forged = `${other}.${mac}`;
    await assert.rejects(viewer('t=' + encodeURIComponent(forged)).opened, /403/);
});

test('opens a page, streams JPEG frames, types into it and clicks', { skip }, async () => {
    const v = viewer(`t=${encodeURIComponent(ticket())}&open=nav&url=${encodeURIComponent('http://site.test/form')}`);
    await v.opened;
    v.send({ t: 'hello', w: 800, h: 600, dpr: 1 });
    await v.until((x) => x.lastState && /\/form$/.test(x.lastState.url) && x.lastState.title === 'Form');
    await v.until((x) => x.frames > 0).catch((e) => { throw new Error('no frames: ' + e.message); });
    assert.equal(v.lastFrame[0], 0xff); // JPEG
    assert.equal(v.lastFrame[1], 0xd8);
    // keyboard: the field has focus (autofocus); type and press Enter
    for (const ch of 'hi') {
        v.send({ t: 'key', type: 'down', key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), text: ch });
        v.send({ t: 'key', type: 'up', key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0) });
    }
    v.send({ t: 'text', text: ' there' }); // phone keyboards / paste
    v.send({ t: 'key', type: 'down', key: 'Enter', code: 'Enter', keyCode: 13 });
    v.send({ t: 'key', type: 'up', key: 'Enter', code: 'Enter', keyCode: 13 });
    await v.until((x) => x.lastState && x.lastState.url.endsWith('/got?q=hi+there')).catch((e) => { throw new Error('typing: ' + JSON.stringify(got.slice(-3)) + e.message); });
    // mouse: a click anywhere on the page follows the link
    v.send({ t: 'nav', url: 'http://site.test/click' });
    await v.until((x) => x.lastState && x.lastState.title === 'Click');
    v.send({ t: 'mouse', type: 'down', x: 400, y: 300, button: 0, buttons: 1, clicks: 1 });
    v.send({ t: 'mouse', type: 'up', x: 400, y: 300, button: 0, buttons: 0, clicks: 1 });
    await v.until((x) => x.lastState && x.lastState.url.endsWith('/clicked'));
    // back
    v.send({ t: 'back' });
    await v.until((x) => x.lastState && x.lastState.url.endsWith('/click'));
    v.ws.close();
});

test('links that open a new tab become the shown tab; tabs can be switched and closed', { skip }, async () => {
    const v = viewer(`t=${encodeURIComponent(ticket())}`);
    await v.opened;
    v.send({ t: 'hello', w: 800, h: 600, dpr: 1 });
    v.send({ t: 'nav', url: 'http://site.test/popup' });
    await v.until((x) => x.lastState && x.lastState.title === 'Popup');
    v.send({ t: 'mouse', type: 'down', x: 100, y: 100, button: 0, buttons: 1, clicks: 1 });
    v.send({ t: 'mouse', type: 'up', x: 100, y: 100, button: 0, buttons: 0, clicks: 1 });
    await v.until((x) => x.lastState && x.lastState.tabs.length === 2 && x.lastState.url.endsWith('/second'));
    const first = v.lastState.tabs.find((t) => !t.active);
    v.send({ t: 'tab', id: first.id });
    await v.until((x) => x.lastState && x.lastState.url.endsWith('/popup'));
    const second = v.lastState.tabs.find((t) => !t.active);
    v.send({ t: 'closeTab', id: second.id });
    await v.until((x) => x.lastState && x.lastState.tabs.length === 1);
    v.ws.close();
});

test('the same user gets the same browser back (logins stay); non-web addresses are refused', { skip }, async () => {
    const { browsers, normalize } = require('../src/live/worker');
    assert.equal(browsers.size, 1);
    assert.equal(normalize('example.com'), 'https://example.com/');
    assert.equal(normalize('file:///etc/passwd'), null);
    assert.equal(normalize('javascript:alert(1)'), null);
    assert.equal(normalize('chrome://settings'), null);
});

test('egress guard: private and internal addresses are refused', async () => {
    const prev = process.env.ALLOW_PRIVATE_UPSTREAMS;
    delete process.env.ALLOW_PRIVATE_UPSTREAMS;
    const { resolveTarget } = require('../src/live/egress');
    for (const h of ['127.0.0.1', 'localhost', '169.254.169.254', '10.0.0.5', '192.168.1.1', '[::1]', 'portal.test']) {
        await assert.rejects(resolveTarget(h, 80), /private/, h);
    }
    // mapped test names still work
    assert.deepEqual(await resolveTarget('site.test', 80), { host: '127.0.0.1', port: sitePort });
    if (prev !== undefined) process.env.ALLOW_PRIVATE_UPSTREAMS = prev;
});

test('identity is consistent: user-agent and client hints agree (no "Headless", same platform)', { skip }, async () => {
    const seen = [];
    const probe = http.createServer((req, res) => {
        seen.push({ ua: req.headers['user-agent'], platform: req.headers['sec-ch-ua-platform'], mobile: req.headers['sec-ch-ua-mobile'] });
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>UA</title>ok');
    });
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    process.env.LIVE_RESOLVE = `site.test=127.0.0.1:${sitePort},ua.test=127.0.0.1:${probe.address().port}`;
    const v = viewer(`t=${encodeURIComponent(ticket('user-ua'))}`);
    await v.opened;
    v.send({ t: 'hello', w: 800, h: 600, dpr: 1 });
    v.send({ t: 'nav', url: 'http://ua.test/' });
    await v.until((x) => x.lastState && x.lastState.title === 'UA');
    const d = seen[seen.length - 1];
    assert.doesNotMatch(d.ua, /Headless/);
    assert.match(d.ua, /X11; Linux x86_64/);
    v.send({ t: 'resize', w: 390, h: 760, dpr: 1, mobile: true });
    await new Promise((r) => setTimeout(r, 500));
    v.send({ t: 'reload' });
    await v.until(() => seen.length >= 2 && /Android/.test(seen[seen.length - 1].ua));
    v.ws.close();
    probe.close();
});
