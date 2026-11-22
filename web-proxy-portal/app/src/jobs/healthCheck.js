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

/** Probes one proxy. @returns {Promise<{ok:boolean, latencyMs?:number, error?:string}>} */
async function probe(proxy, { url = config.healthCheck.url, timeoutMs = config.healthCheck.timeoutMs } = {}) {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const started = Date.now();
    let socket;
    const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs).unref());
    try {
        const run = (async () => {
            socket = await openTunnel(proxy, target.hostname, port, timeoutMs);
            if (isHttps) {
                socket = await new Promise((resolve, reject) => {
                    const s = tls.connect({ socket, servername: target.hostname }, () => resolve(s));
                    s.once('error', reject);
                });
            }
            const status = await new Promise((resolve, reject) => {
                let buf = '';
                socket.on('data', (d) => {
                    buf += d.toString('latin1');
                    const line = buf.split('\r\n')[0];
                    if (buf.includes('\r\n')) resolve(Number((line.match(/^HTTP\/[\d.]+\s+(\d{3})/) || [])[1]) || 0);
                });
                socket.once('error', reject);
                socket.once('end', () => reject(new Error('connection closed before response')));
                socket.write(`HEAD ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: portal-healthcheck\r\nConnection: close\r\n\r\n`);
            });
            if (status < 200 || status >= 500) throw new Error(`unexpected status ${status}`);
            return { ok: true, latencyMs: Date.now() - started };
        })();
        return await Promise.race([run, timer]);
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (socket) socket.destroy();
    }
}

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

module.exports = { probe, checkAll, schedule };
