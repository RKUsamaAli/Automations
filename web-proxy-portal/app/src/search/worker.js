'use strict';
/**
 * SEARCH WORKER process (PM2 app "portal-search").
 *
 * Google refuses search pages whose scripts were rewritten by a web proxy, so
 * Google results are fetched by a REAL headless Chromium here, through the
 * same upstream proxy the user browses with, and returned as a plain list.
 * The user then opens a result through the proxy as usual.
 *
 *   POST http://127.0.0.1:SEARCH_PORT/search   (X-Search-Key header, internal only)
 *     { q, proxy: {protocol, host, port, username, password} | null, lang }
 *   -> { engine: 'google'|'duckduckgo', results: [{title,url,displayUrl,snippet}], note?, blocked?, ms }
 *
 * - One browser, a fresh isolated context per search (own proxy, no shared cookies).
 * - Images/fonts/media are not downloaded (faster, less proxy traffic).
 * - Google asks for a CAPTCHA (common on datacenter IPs) or shows nothing:
 *   DuckDuckGo results are fetched instead, through the same proxy, with a note.
 * - At most SEARCH_CONCURRENCY searches at a time; the rest wait in a queue.
 */
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const { deriveKey } = require('../lib/crypto');
const system = require('../lib/system');
const { extractGoogle, classifyGoogle, extractDuckDuckGo } = require('./extract');
const log = require('../lib/logger')('search-worker');

const PORT = Number(process.env.SEARCH_PORT) || 3003;
const CONCURRENCY = Math.max(1, Number(process.env.SEARCH_CONCURRENCY) || 2);
const TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 20000;
const GOOGLE_URL = () => process.env.GOOGLE_SEARCH_URL || 'https://www.google.com/search?q={q}&num=10&hl={hl}';
const DDG_URL = () => process.env.DDG_SEARCH_URL || 'https://html.duckduckgo.com/html/?q={q}';

function workerKey() {
    return crypto.createHmac('sha256', deriveKey(config.appSecret, 'search-worker')).update('v1').digest('base64url');
}

// ------------------------------------------------------------- browser ----
let browserPromise = null;
function browser() {
    if (!browserPromise) {
        const { chromium } = require('playwright-core');
        browserPromise = chromium
            .launch({
                headless: true,
                executablePath: process.env.CHROMIUM_PATH || undefined,
                // Chromium's own sandbox needs user namespaces (often blocked on Ubuntu 24.04);
                // every search runs in its own context and only renders search pages.
                chromiumSandbox: false,
                args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--mute-audio']
            })
            .then((b) => {
                b.on('disconnected', () => {
                    browserPromise = null;
                    log.warn('browser exited, will relaunch on the next search');
                });
                log.info('browser started', { version: b.version() });
                return b;
            })
            .catch((e) => {
                browserPromise = null;
                throw e;
            });
    }
    return browserPromise;
}

// ---------------------------------------------------------------- queue ----
let running = 0;
const waiting = [];
function slot() {
    if (running < CONCURRENCY) {
        running += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
}
function release() {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
}

const fill = (t, q, hl) => t.replace(/\{q\}/g, encodeURIComponent(q)).replace(/\{hl\}/g, encodeURIComponent(hl));

function proxyOption(p) {
    if (!p) return undefined;
    if (p.protocol === 'socks5' && p.username) {
        // Chromium cannot log in to SOCKS proxies.
        throw Object.assign(new Error('Search through a SOCKS5 proxy with a password is not supported. Use an HTTP proxy for searching.'), { expected: true });
    }
    return { server: `${p.protocol === 'socks5' ? 'socks5' : 'http'}://${p.host}:${p.port}`, username: p.username || undefined, password: p.password || undefined };
}

async function run({ q, proxy, lang }) {
    const started = Date.now();
    const hl = /^[a-z]{2}(-[A-Z]{2})?$/.test(lang || '') ? lang : 'en';
    const b = await browser();
    const ctx = await b.newContext({
        proxy: proxyOption(proxy),
        locale: hl,
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true
    });
    try {
        // Skip Google's cookie-consent interstitial (EU exit IPs) and heavy resources.
        await ctx.addCookies([
            { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com', path: '/' },
            { name: 'CONSENT', value: 'YES+', domain: '.google.com', path: '/' }
        ]);
        await ctx.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
        const page = await ctx.newPage();
        page.setDefaultTimeout(TIMEOUT_MS);

        let kind = 'unknown';
        let results = [];
        let googleError = null;
        try {
            await page.goto(fill(GOOGLE_URL(), q, hl), { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#search, #rso, #captcha-form, form[action*="sorry"], form[action*="consent"]', { timeout: Math.min(8000, TIMEOUT_MS) }).catch(() => {});
            kind = await page.evaluate(classifyGoogle);
            if (kind === 'results') results = await page.evaluate(extractGoogle);
        } catch (e) {
            googleError = e.message;
        }
        if (results.length) return { engine: 'google', results, ms: Date.now() - started };

        // Fallback: DuckDuckGo through the same proxy.
        const why =
            kind === 'captcha'
                ? 'Google asked for a CAPTCHA through this proxy'
                : kind === 'consent'
                  ? 'Google showed a consent page'
                  : googleError
                    ? `Google did not answer (${googleError.split('\n')[0].slice(0, 120)})`
                    : 'Google returned no results';
        await page.goto(fill(DDG_URL(), q, hl), { waitUntil: 'domcontentloaded' });
        results = await page.evaluate(extractDuckDuckGo);
        return { engine: 'duckduckgo', results, blocked: kind === 'captcha' ? 'captcha' : kind, note: `${why}, so these results come from DuckDuckGo.`, ms: Date.now() - started };
    } finally {
        await ctx.close().catch(() => {});
    }
}

// --------------------------------------------------------------- server ----
function readJson(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size < 16384) chunks.push(c);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (_) {
                resolve(null);
            }
        });
    });
}

function start() {
    system.setProcessName('search');
    const key = workerKey();
    const server = http.createServer(async (req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true, running, waiting: waiting.length, browser: !!browserPromise });
        if (req.method !== 'POST' || req.url !== '/search') return send(404, { error: 'Not found' });
        const given = String(req.headers['x-search-key'] || '');
        if (given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return send(403, { error: 'Not allowed' });
        const body = await readJson(req);
        if (!body || typeof body.q !== 'string' || !body.q.trim()) return send(400, { error: 'Missing search words' });
        await slot();
        try {
            send(200, await run({ q: body.q.trim().slice(0, 300), proxy: body.proxy || null, lang: body.lang }));
        } catch (e) {
            if (!e.expected) log.error('search failed', { error: e.message });
            send(e.expected ? 400 : 502, { error: e.expected ? e.message : 'The search could not be completed. Try again or use another proxy.', detail: e.message.split('\n')[0].slice(0, 200) });
        } finally {
            release();
        }
    });
    server.listen(PORT, '127.0.0.1', () => {
        log.info(`search worker listening on 127.0.0.1:${PORT} (concurrency ${CONCURRENCY})`);
        if (process.send) process.send('ready');
    });
    const stop = () => {
        server.close();
        Promise.resolve(browserPromise)
            .then((b) => b && b.close())
            .catch(() => {})
            .finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return server;
}

if (require.main === module) {
    config.validate();
    start();
}

/** Closes the shared browser (tests, shutdown). */
async function shutdown() {
    const b = await Promise.resolve(browserPromise).catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
}

module.exports = { start, run, shutdown, workerKey, PORT };
