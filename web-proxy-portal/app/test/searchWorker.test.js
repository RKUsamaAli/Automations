'use strict';
/**
 * Search worker with a REAL headless Chromium against a local fake Google /
 * DuckDuckGo: results are read from the page, Google's /url?q= links are
 * unwrapped, and a CAPTCHA page falls back to DuckDuckGo with a note.
 * Skipped when no Chromium is installed.
 */
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const GOOGLE_HTML = (q) => `<!doctype html><html><body><div id="search"><div id="rso">
  <div class="MjjYud"><div data-hveid="1"><a href="https://www.example.org/a?x=1"><h3>Result A for ${q}</h3></a><div class="VwiC3b">Snippet A text</div></div></div>
  <div class="MjjYud"><div data-hveid="2"><a href="/url?q=https://shop.example.com/b&amp;sa=U"><h3>Result B</h3></a><div class="VwiC3b">Snippet B</div></div></div>
  <div class="MjjYud"><a href="https://www.google.com/search?q=related"><h3>Google internal</h3></a></div>
</div></div></body></html>`;
const DDG_HTML = `<!doctype html><html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduck.example.net%2Fpage">Duck result</a><a class="result__snippet">Duck snippet</a></div></body></html>`;

let server;
let port;
let chromiumOk = true;
try {
    require('fs').accessSync(require('playwright-core').chromium.executablePath());
} catch (_) {
    chromiumOk = false;
}

test.before(async () => {
    server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/search' && u.searchParams.get('q') === 'robot check') {
            res.writeHead(302, { location: '/sorry/index?continue=x' });
            return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        if (u.pathname === '/search') return res.end(GOOGLE_HTML(u.searchParams.get('q')));
        if (u.pathname.startsWith('/sorry')) return res.end('<html><body><form id="captcha-form" action="index">captcha</form></body></html>');
        if (u.pathname === '/ddg') return res.end(DDG_HTML);
        res.end('');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    process.env.GOOGLE_SEARCH_URL = `http://127.0.0.1:${port}/search?q={q}`;
    process.env.DDG_SEARCH_URL = `http://127.0.0.1:${port}/ddg?q={q}`;
    require('./helpers');
});
test.after(async () => {
    server && server.close();
    // close the shared browser so the test process can exit
    try {
        const w = require('../src/search/worker');
        await w.shutdown();
    } catch (_) {
        /* ignore */
    }
});

test('Google results from the page; /url?q= unwrapped; Google-internal links skipped', { skip: !chromiumOk && 'no Chromium installed' }, async () => {
    const { run } = require('../src/search/worker');
    const r = await run({ q: 'pizza', proxy: null, lang: 'en' });
    assert.equal(r.engine, 'google');
    assert.deepEqual(r.results.map((x) => x.url), ['https://www.example.org/a?x=1', 'https://shop.example.com/b']);
    assert.equal(r.results[0].title, 'Result A for pizza');
    assert.equal(r.results[0].snippet, 'Snippet A text');
    assert.equal(r.results[1].displayUrl, 'shop.example.com');
});

test('CAPTCHA from Google -> DuckDuckGo results with a note', { skip: !chromiumOk && 'no Chromium installed' }, async () => {
    const { run } = require('../src/search/worker');
    const r = await run({ q: 'robot check', proxy: null, lang: 'en' });
    assert.equal(r.engine, 'duckduckgo');
    assert.equal(r.blocked, 'captcha');
    assert.match(r.note, /CAPTCHA/);
    assert.deepEqual(r.results.map((x) => x.url), ['https://duck.example.net/page']);
});

test('SOCKS5 proxies with a password are refused clearly', { skip: !chromiumOk && 'no Chromium installed' }, async () => {
    const { run } = require('../src/search/worker');
    await assert.rejects(run({ q: 'x', proxy: { protocol: 'socks5', host: '203.0.113.1', port: 1080, username: 'u', password: 'p' } }), /SOCKS5/);
});
