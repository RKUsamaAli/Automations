'use strict';
/**
 * Client for the search worker (src/search/worker.js), used by the portal
 * (Browse page results) and the proxy engine (floating toolbar).
 *
 *   await webSearch.search({ q, proxy, lang }) -> { engine, results, note?, cached? } or throws
 *
 * Results are cached for 10 minutes per (words, proxy, language).
 */
const http = require('http');
const TtlCache = require('../lib/ttlCache');
const { workerKey, PORT } = require('../search/worker');

const cache = new TtlCache(10 * 60000, 500);
let key = null;

function call(body, timeoutMs = 35000) {
    key = key || workerKey();
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const req = http.request(
            { host: '127.0.0.1', port: Number(process.env.SEARCH_PORT) || PORT, path: '/search', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Search-Key': key }, timeout: timeoutMs },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    let json = {};
                    try {
                        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch (_) {
                        /* keep empty */
                    }
                    if (res.statusCode === 200) resolve(json);
                    else reject(Object.assign(new Error(json.error || `Search failed (${res.statusCode})`), { status: res.statusCode, detail: json.detail }));
                });
            }
        );
        req.on('timeout', () => req.destroy(new Error('The search took too long. Try again.')));
        req.on('error', (e) => reject(e.code === 'ECONNREFUSED' ? Object.assign(new Error('The search service is not running on the server.'), { status: 503 }) : e));
        req.end(data);
    });
}

async function search({ q, proxy = null, lang = 'en' }) {
    const k = `${String(q).trim().toLowerCase()}|${proxy ? proxy.id : 'direct'}|${lang}`;
    const hit = cache.get(k);
    if (hit) return { ...hit, cached: true };
    const p = proxy ? { protocol: proxy.protocol, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password } : null;
    const result = await call({ q, proxy: p, lang });
    if (result.results && result.results.length) cache.set(k, result);
    return result;
}

/**
 * Which proxy a search should go out through.
 *   via = 'direct' | <pool id> (a proxy is picked from it) | <proxy id of a session>
 */
function proxyFor(user, via) {
    const pools = require('./pools');
    if (!via || via === 'direct') return { proxy: null, label: 'No proxy (direct)' };
    if (pools.canUsePool(user, via)) {
        const proxy = pools.pickProxy(via);
        if (!proxy) throw Object.assign(new Error('No proxy of that pool is online right now'), { status: 503 });
        return { proxy, label: require('./sessionProxy').label(proxy) };
    }
    throw Object.assign(new Error('You are not allowed to use that proxy pool'), { status: 403 });
}

/** True when words typed by users should be answered with Google results from the server browser. */
function useServerGoogle() {
    return require('./settings').get('search_engine') === 'google';
}

module.exports = { search, proxyFor, useServerGoogle };
