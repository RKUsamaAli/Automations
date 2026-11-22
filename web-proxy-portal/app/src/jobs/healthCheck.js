'use strict';
/**
 * Upstream proxy health checker.
 *
 * For every enabled proxy it opens a tunnel THROUGH the proxy to
 * HEALTHCHECK_URL (default https://www.gstatic.com/generate_204), performs a
 * HEAD request and measures the total time.
 *
 *   ok + fast            -> healthy
 *   ok + slower than X   -> slow     (used only as a last resort)
 *   fails N times in row -> dead     (never assigned to new sessions)
 *
 * Runs on a schedule inside the proxy process (primary only) and on demand
 * from the admin panel ("Check now").
 */
const tls = require('tls');
const config = require('../config');
const pools = require('../services/pools');
const events = require('../services/events');
const { openTunnel } = require('../lib/tunnel');
const { describeProxy } = require('../lib/proxyString');
const log = require('../lib/logger')('healthcheck');

/**
 * One HTTP request THROUGH a proxy (tunnel + optional TLS), raw and minimal.
 * @returns {Promise<{ status:number, body:string, ms:number }>}
 */
async function requestVia(proxy, url, { method = 'GET', timeoutMs = config.healthCheck.timeoutMs, maxBody = 4096 } = {}) {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const started = Date.now();
    let socket;
    let timerId;
    const timer = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        timerId.unref();
    });
    try {
        const run = (async () => {
            socket = await openTunnel(proxy, target.hostname, port, timeoutMs);
            if (isHttps) {
                socket = await new Promise((resolve, reject) => {
                    const s = tls.connect({ socket, servername: target.hostname }, () => resolve(s));
                    s.once('error', reject);
                });
            }
            const raw = await new Promise((resolve, reject) => {
                let buf = '';
                const done = () => resolve(buf);
                socket.on('data', (d) => {
                    buf += d.toString('latin1');
                    // HEAD: the status line is enough; GET: read the (small) body
                    if (method === 'HEAD' && buf.includes('\r\n')) done();
                    if (buf.length > maxBody + 4096) done();
                });
                socket.once('error', reject);
                socket.once('end', () => (buf ? done() : reject(new Error('connection closed before response'))));
                socket.write(`${method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: portal-healthcheck\r\nAccept: application/json, */*\r\nConnection: close\r\n\r\n`);
            });
            const status = Number((raw.match(/^HTTP\/[\d.]+\s+(\d{3})/) || [])[1]) || 0;
            const i = raw.indexOf('\r\n\r\n');
            let body = i >= 0 ? raw.slice(i + 4) : '';
            if (/\r\ntransfer-encoding:\s*chunked/i.test(raw.slice(0, i))) body = body.replace(/^[0-9a-f]+\r\n/i, '').replace(/\r\n0\r\n[\s\S]*$/, '');
            return { status, body: body.slice(0, maxBody), ms: Date.now() - started };
        })();
        return await Promise.race([run, timer]);
    } finally {
        clearTimeout(timerId);
        if (socket) socket.destroy();
    }
}

/** Probes one proxy. @returns {Promise<{ok:boolean, latencyMs?:number, error?:string}>} */
async function probe(proxy, { url = config.healthCheck.url, timeoutMs = config.healthCheck.timeoutMs } = {}) {
    try {
        const r = await requestVia(proxy, url, { method: 'HEAD', timeoutMs });
        if (r.status < 200 || r.status >= 500) throw new Error(`unexpected status ${r.status}`);
        return { ok: true, latencyMs: r.ms };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/**
 * The proxy's exit IP: asks an IP-echo service through it.
 * EXIT_IP_CHECK_URL must answer JSON {"ip": "..."} (default ipify) or plain text.
 * @returns {Promise<{ ok:boolean, ip?:string, latencyMs?:number, error?:string }>}
 */
async function exitIp(proxy, { timeoutMs = config.healthCheck.timeoutMs } = {}) {
    const url = process.env.EXIT_IP_CHECK_URL || 'https://ipwho.is/';
    try {
        const r = await requestVia(proxy, url, { method: 'GET', timeoutMs, maxBody: 8192 });
        if (r.status !== 200) throw new Error(`IP check answered HTTP ${r.status}`);
        let info = {};
        try {
            info = JSON.parse(r.body);
        } catch (_) {
            info = { ip: r.body.trim() };
        }
        const ip = info.ip;
        if (typeof ip !== 'string' || !/^[0-9a-f:.]{3,45}$/i.test(ip)) throw new Error('IP check returned no IP');
        // ipwho.is style: country, country_code, city, connection.isp (other services: ip only)
        const clean = (v, n = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
        const geo = {
            ip,
            country: clean(info.country),
            countryCode: clean(info.country_code || info.countryCode, 2),
            city: clean(info.city),
            isp: clean((info.connection && (info.connection.isp || info.connection.org)) || info.isp || info.org),
            timeZone: validTimeZone((info.timezone && info.timezone.id) || info.timezone || info.time_zone)
        };
        pools.recordExitIp(proxy.id, geo);
        return { ok: true, ...geo, latencyMs: r.ms };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** An IANA time zone name the runtime knows ("Europe/Madrid"), else null. */
function validTimeZone(v) {
    if (typeof v !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(v) || v.length > 64) return null;
    try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return v;
    } catch (_) {
        return null;
    }
}

/**
 * The server's own internet connection (sessions with no proxy): public IP,
 * location and time zone, from the same IP-info service. Cached for an hour.
 * Falls back to the server clock's time zone when the lookup fails.
 */
let directCache = null;
async function directExit({ timeoutMs = 6000 } = {}) {
    if (directCache && Date.now() - directCache.at < (directCache.ok ? EXIT_IP_MAX_AGE_MS : 5 * 60000)) return directCache.value;
    const fallback = { ip: null, country: null, countryCode: null, city: null, isp: null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    let value = fallback;
    let ok = false;
    try {
        const ctl = AbortSignal.timeout(timeoutMs);
        const r = await fetch(process.env.EXIT_IP_CHECK_URL || 'https://ipwho.is/', { signal: ctl, headers: { accept: 'application/json' } });
        const info = await r.json();
        const clean = (v, n = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
        if (typeof info.ip === 'string' && /^[0-9a-f:.]{3,45}$/i.test(info.ip)) {
            value = {
                ip: info.ip,
                country: clean(info.country),
                countryCode: clean(info.country_code || info.countryCode, 2),
                city: clean(info.city),
                isp: clean((info.connection && (info.connection.isp || info.connection.org)) || info.isp || info.org),
                timeZone: validTimeZone((info.timezone && info.timezone.id) || info.timezone || info.time_zone) || fallback.timeZone
            };
            ok = true;
        }
    } catch (_) {
        /* keep the fallback */
    }
    directCache = { at: Date.now(), ok, value };
    return value;
}

const EXIT_IP_MAX_AGE_MS = 60 * 60000; // re-check a proxy's exit IP at most hourly

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
    const results = [];
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}

let running = false;

/**
 * Checks all enabled proxies (or only those of one pool).
 * @returns {Promise<{checked:number, healthy:number, slow:number, dead:number}>}
 */
async function checkAll({ poolId = null } = {}) {
    if (running) return { skipped: true };
    running = true;
    const hc = config.healthCheck;
    const summary = { checked: 0, healthy: 0, slow: 0, dead: 0, unknown: 0 };
    try {
        const list = pools.allProxiesWithSecrets().filter((p) => p.enabled && (!poolId || p.pool_id === poolId));
        await mapLimit(list, hc.concurrency, async (proxy) => {
            const result = await probe(proxy);
            // exit IP + location: refreshed at most hourly per proxy
            if (result.ok && (!proxy.exit_ip_checked_at || Date.now() - proxy.exit_ip_checked_at > EXIT_IP_MAX_AGE_MS)) await exitIp(proxy);
            const before = proxy.status;
            const status = pools.recordHealth(proxy.id, { ...result, slowMs: hc.slowMs, failuresBeforeDead: hc.failuresBeforeDead });
            summary.checked++;
            if (status) summary[status] = (summary[status] || 0) + 1;
            if (status === 'dead' && before !== 'dead') {
                events.record('proxy_dead', { detail: `${describeProxy(proxy)}: ${result.error}` });
                log.warn(`proxy marked dead: ${describeProxy(proxy)} (${result.error})`);
            } else if (before === 'dead' && status === 'healthy') {
                events.record('proxy_recovered', { detail: describeProxy(proxy) });
            }
        });
        if (summary.checked) log.info('health check finished', summary);
        return summary;
    } finally {
        running = false;
    }
}

/** Starts the periodic schedule. Returns a stop function. */
function schedule() {
    if (!config.healthCheck.enabled) {
        log.info('health checks disabled (HEALTHCHECK_ENABLED=false)');
        return () => {};
    }
    const tick = () => checkAll().catch((e) => log.error('health check crashed', e));
    const first = setTimeout(tick, 15000); // shortly after boot
    const timer = setInterval(tick, config.healthCheck.intervalMin * 60000);
    first.unref();
    timer.unref();
    return () => {
        clearTimeout(first);
        clearInterval(timer);
    };
}

module.exports = { probe, exitIp, directExit, validTimeZone, requestVia, checkAll, schedule };
