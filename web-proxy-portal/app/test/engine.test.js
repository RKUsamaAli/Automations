'use strict';
/**
 * END-TO-END test with the REAL Rammerhead engine.
 *
 * Starts src/proxy/server.js as a child process on free ports, a fake target
 * website and a fake upstream HTTP proxy, then walks the full flow:
 *   ticket -> /__portal/start -> cookie + redirect -> proxied page
 *   -> traffic really goes through the upstream proxy (with credentials)
 *   -> custom script tag injected and bundle served for that page
 *   -> no cookie = redirect to login, wrong user = 403
 *
 * Skipped automatically when Rammerhead is not built (vendor/rammerhead or
 * RAMMERHEAD_DIR). deploy.sh links the engine before running tests, so this
 * runs on every deploy.
 */
const { tmp } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const rhDir = path.resolve(__dirname, '..', process.env.RAMMERHEAD_DIR || 'vendor/rammerhead');
const engineAvailable = fs.existsSync(path.join(rhDir, 'src/client/hammerhead.min.js'));

const freePort = () =>
    new Promise((resolve) => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });

async function get(url, headers = {}) {
    const res = await fetch(url, { headers, redirect: 'manual' });
    return { status: res.status, headers: res.headers, text: await res.text() };
}

test('real engine: hand-off, sticky upstream proxy, script injection, access control', { skip: !engineAvailable && 'Rammerhead not built', timeout: 90000 }, async (t) => {
    const users = require('../src/services/users');
    const pools = require('../src/services/pools');
    const scripts = require('../src/services/scripts');
    const settings = require('../src/services/settings');
    const { mintTicket, mintProxy, COOKIE_PROXY } = require('../src/lib/authTokens');

    // ---- fake target site ----
    const sitePort = await freePort();
    const site = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Target</title></head><body><h1 id="x">Hello target</h1><a href="/next">next</a></body></html>');
    });
    await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));

    // ---- fake upstream proxy (absolute-URL HTTP), records what it saw ----
    const seen = [];
    const upPort = await freePort();
    const upstream = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers['proxy-authorization'] || null, xff: req.headers['x-forwarded-for'] || null });
        const target = new URL(req.url);
        // failure scenarios for the error-reporting checks
        if (target.hostname === 'reset.localtest') return req.socket.destroy(); // upstream drops the connection
        if (target.hostname === 'error.localtest') {
            res.writeHead(503, { 'content-type': 'text/html' });
            return res.end('<h1>Service unavailable</h1>');
        }
        // Like a real provider resolving DNS: *.localtest -> the fake site on 127.0.0.1.
        const host = target.hostname.endsWith('.localtest') ? '127.0.0.1' : target.hostname;
        const out = http.request({ host, port: target.port, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        out.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        req.pipe(out);
    });
    await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

    // ---- data ----
    const alice = users.create({ username: 'eng-alice', password: 'password123' }).user;
    const bob = users.create({ username: 'eng-bob', password: 'password123' }).user;
    const pool = pools.savePool({ name: 'engine-test', isDefault: true });
    pools.importProxies(pool.id, `http://puser:ppass@127.0.0.1:${upPort}`);
    const proxyRow = pools.listProxies(pool.id)[0];
    pools.recordHealth(proxyRow.id, { ok: true, latencyMs: 5, slowMs: 5000, failuresBeforeDead: 3 });
    scripts.save({ name: 'engine-marker', domains: 'shop.localtest', code: 'window.__engineMarker = 42;' });
    settings.update({ upstream_fallback: 'deny' });

    // ---- start the engine ----
    const port = await freePort();
    const crossPort = await freePort();
    const env = {
        ...process.env,
        ENV_FILE: '/dev/null',
        RAMMERHEAD_DIR: rhDir,
        PROXY_PORT: String(port),
        PROXY_CROSS_DOMAIN_PORT: String(crossPort),
        PROXY_DOMAIN: '127.0.0.1',
        PUBLIC_PROTOCOL: 'http',
        PUBLIC_PORT: String(port),
        PUBLIC_CROSS_DOMAIN_PORT: String(crossPort),
        PROXY_WORKERS: '0',
        DATA_DIR: tmp,
        LOG_LEVEL: 'warn',
        METRICS_INTERVAL_MS: '500'
    };
    const child = spawn(process.execPath, [path.join(__dirname, '../src/proxy/server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    t.after(() => {
        child.kill('SIGINT');
        site.close();
        upstream.close();
    });

    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
            const h = await get(`${base}/__portal/healthz`);
            healthy = h.status === 200 && JSON.parse(h.text).release === require('../src/config').releaseName;
        } catch (_) {
            /* not up yet */
        }
    }
    assert.ok(healthy, `engine did not start:\n${output}`);

    // ---- 1. hand-off ----
    // A public-looking hostname: the portal refuses to proxy to private addresses like 127.0.0.1.
    const target = `http://shop.localtest:${sitePort}/`;
    const ticket = mintTicket({ uid: alice.id, v: alice.token_version, url: target });
    const start = await get(`${base}/__portal/start?t=${encodeURIComponent(ticket)}`);
    assert.equal(start.status, 302, start.text);
    const location = start.headers.get('location');
    const sid = location.split('/')[1];
    assert.match(sid, /^[a-z0-9]{32}$/i);
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith(COOKIE_PROXY + '=')).split(';')[0];

    // replaying the same ticket is refused
    assert.equal((await get(`${base}/__portal/start?t=${encodeURIComponent(ticket)}`)).status, 400);

    // ---- 2. proxied page through the upstream proxy ----
    const page = await get(base + location, { cookie, accept: 'text/html', 'sec-fetch-dest': 'document', 'x-real-ip': '203.0.113.9' });
    assert.equal(page.status, 200, page.text.slice(0, 500));
    assert.match(page.text, /Hello target/);
    assert.match(page.text, /__portal\/inject\.js/, 'custom script loader is injected into the page');
    assert.ok(seen.length >= 1, 'request went through the upstream proxy');
    assert.equal(seen[0].auth, 'Basic ' + Buffer.from('puser:ppass').toString('base64'), 'upstream credentials sent');
    assert.equal(seen[0].xff, null, 'client IP headers are not leaked to the site');

    // ---- 3. script bundle for that page ----
    const bundle = await get(`${base}/__portal/inject.js`, { cookie, referer: base + location });
    assert.equal(bundle.status, 200);
    assert.match(bundle.text, /__engineMarker = 42/);

    // ---- 4. access control ----
    // proxying to a private address is refused even inside a valid session
    const priv = await get(`${base}/${sid}/http://127.0.0.1:${sitePort}/`, { cookie, accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.equal(priv.status, 403, 'SSRF to 127.0.0.1 blocked');
    const anon = await get(base + location, { accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /\/login$/);
    const bobCookie = `${COOKIE_PROXY}=${mintProxy(bob).token}`;
    assert.equal((await get(base + location, { cookie: bobCookie, accept: 'text/html' })).status, 403);

    // ---- 5. failures produce an error page with a reference + a report with the trail ----
    const errorReports = require('../src/services/errorReports');
    const t0 = Date.now();
    const broken = await get(`${base}/${sid}/http://reset.localtest:${sitePort}/checkout`, { cookie, accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.ok(Date.now() - t0 < 20000, 'answered quickly instead of hanging');
    assert.equal(broken.status, 502, broken.text.slice(0, 300));
    assert.match(broken.text, /couldn&#39;t load|couldn't load/);
    const ref = (broken.text.match(/E-[2-9A-HJ-NP-Z]{6}/) || [])[0];
    assert.ok(ref, 'reference shown to the user');
    const report = errorReports.get(ref);
    assert.equal(report.kind, 'page_load_failed');
    assert.equal(report.session_id, sid);
    assert.equal(report.dest_host, 'reset.localtest');
    assert.match(report.context.upstream, /127\.0\.0\.1/);
    const trailText = report.breadcrumbs.map((c) => `${c.type}:${c.url || c.event}`).join(' | ');
    assert.ok(trailText.includes('page:http://shop.localtest'), 'earlier page in the trail: ' + trailText);
    assert.ok(trailText.includes('event:session_start'), 'session start in the trail: ' + trailText);

    await get(`${base}/${sid}/http://error.localtest:${sitePort}/`, { cookie, accept: 'text/html', 'sec-fetch-dest': 'document' });
    let siteErr;
    for (let i = 0; i < 20 && !siteErr; i++) {
        siteErr = errorReports.list({ status: 'all', q: 'error.localtest' })[0];
        if (!siteErr) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(siteErr, 'site 5xx recorded');
    assert.equal(siteErr.kind, 'site_error');
    assert.equal(siteErr.severity, 'warning');

    // ---- 6. normal activity is logged too: pages, failures, server health ----
    const requestLog = require('../src/services/requestLog');
    await new Promise((r) => setTimeout(r, 2600)); // engine flushes its request log every 2 s
    const timeline = requestLog.sessionTimeline(sid);
    const okPage = timeline.find((r) => r.kind === 'page' && r.host === 'shop.localtest' && r.status === 200);
    assert.ok(okPage, 'successful page view stored: ' + JSON.stringify(timeline.map((r) => [r.kind, r.host, r.status])));
    assert.equal(okPage.proxy_id, proxyRow.id, 'with the upstream proxy used');
    assert.ok(okPage.ms >= 0 && okPage.bytes > 0);
    assert.ok(timeline.some((r) => r.host === 'reset.localtest' && r.status === 0 && /reset/.test(r.error)), 'failed page stored with reason');
    const db = require('../src/db');
    const health = db.get().prepare("SELECT COUNT(*) AS samples, MAX(rss_mb) AS rss, SUM(requests) AS requests FROM server_metrics WHERE process = 'proxy'").get();
    assert.ok(health.samples >= 2 && health.rss > 0 && health.requests >= 1, 'engine writes health metrics: ' + JSON.stringify(health));
    assert.ok(db.get().prepare("SELECT 1 FROM events WHERE type = 'process_start' AND detail LIKE 'proxy pid %'").get(), 'process start recorded');

    // ---- 7. DB bookkeeping ----
    const row = require('../src/services/sessions').get(sid);
    assert.equal(row.user_id, alice.id);
    assert.equal(row.proxy_id, proxyRow.id, 'session is stuck to the chosen proxy');
});
