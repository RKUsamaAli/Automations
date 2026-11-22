'use strict';
/**
 * Address bar search ("type words, get a search page, pick a result").
 *
 *   classify('example.com')        -> { type: 'url', url: 'https://example.com/' }
 *   classify('best pizza near me') -> { type: 'search', query: 'best pizza near me', url: <engine results page> }
 *   suggestions('piz')             -> ['pizza', 'pizza hut', ...]   (from the engine, cached)
 *
 * The results page opens THROUGH the proxy like any other page, so search
 * and the sites the user picks use the same upstream proxy and session.
 *
 * Engines (Admin -> Settings -> Search): duckduckgo (default) | bing | google | custom.
 * Google Search refuses pages whose scripts were rewritten by a web proxy
 * (it shows "If you're having trouble accessing Google Search"), so it is not
 * the default; its home page still opens.
 * Custom: a results URL template with {q} (e.g. https://search.example/?q={q})
 * and optionally a suggestion URL returning OpenSearch JSON: ["q", ["a","b"]].
 */
const settings = require('./settings');
const TtlCache = require('../lib/ttlCache');
const log = require('../lib/logger')('search');

const ENGINES = {
    google: { name: 'Google', search: 'https://www.google.com/search?q={q}', suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q={q}' },
    // The HTML (no-JavaScript) version: works reliably through the proxy.
    duckduckgo: { name: 'DuckDuckGo', search: 'https://html.duckduckgo.com/html/?q={q}', suggest: 'https://duckduckgo.com/ac/?type=list&q={q}' },
    bing: { name: 'Bing', search: 'https://www.bing.com/search?q={q}', suggest: 'https://api.bing.com/osjson.aspx?query={q}' }
};

const cache = new TtlCache(10 * 60000, 2000); // query -> suggestions (10 minutes)
const SUGGEST_TIMEOUT_MS = 1500;

/** The configured engine: { name, search, suggest|null }. */
function engine() {
    const s = settings.getAll();
    if (s.search_engine === 'custom' && /\{q\}/.test(s.search_url_custom || '')) {
        let name = 'the web';
        try {
            name = new URL(s.search_url_custom.replace(/\{q\}/g, 'x')).hostname.replace(/^www\./, '');
        } catch (_) {
            /* keep the generic name */
        }
        return { name, search: s.search_url_custom, suggest: /\{q\}/.test(s.search_suggest_url_custom || '') ? s.search_suggest_url_custom : null };
    }
    return ENGINES[s.search_engine] || ENGINES.duckduckgo;
}

const fill = (template, q) => template.replace(/\{q\}/g, encodeURIComponent(q));

function searchUrl(query) {
    return fill(engine().search, String(query).trim().slice(0, 500));
}

/**
 * Address or search words? Like a browser's address bar:
 *  - has a scheme (https://...)              -> address
 *  - contains spaces                          -> search
 *  - host-like: name.tld, IPv4, localhost, with optional :port and /path -> address
 *  - anything else (one word: "weather")     -> search
 */
function classify(input) {
    const raw = String(input || '').trim();
    if (!raw) return { type: 'empty' };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { type: 'url', input: raw };
    // "javascript:", "data:", "file:", "mailto:" ... are addresses (and get rejected), not searches;
    // "localhost:3000" / "example.com:8080" (colon + digits) are host:port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw) && !/\s/.test(raw)) return { type: 'url', input: raw };
    if (/\s/.test(raw)) return { type: 'search', query: raw, url: searchUrl(raw) };
    const host = raw.split(/[/?#]/)[0].replace(/:\d{1,5}$/, '');
    const isHostLike =
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(host) || // example.com, sub.example.co.uk
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || // 203.0.113.5
        host.toLowerCase() === 'localhost';
    if (isHostLike) return { type: 'url', input: raw };
    return { type: 'search', query: raw, url: searchUrl(raw) };
}

/** Search suggestions from the engine (best effort, never throws, never slow). */
async function suggestions(query) {
    const q = String(query || '').trim().slice(0, 100);
    if (q.length < 2 || !settings.get('search_suggestions')) return [];
    const e = engine();
    if (!e.suggest) return [];
    const key = `${e.suggest}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return hit;
    try {
        const res = await fetch(fill(e.suggest, q), { signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (portal search suggestions)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
        const list = (Array.isArray(body) && Array.isArray(body[1]) ? body[1] : Array.isArray(body) ? body.map((x) => x && (x.phrase || x)) : [])
            .filter((x) => typeof x === 'string' && x.trim())
            .map((x) => x.trim().slice(0, 120))
            .slice(0, 6);
        cache.set(key, list);
        return list;
    } catch (err) {
        log.debug('suggestions unavailable', { engine: e.name, error: err.message });
        cache.set(key, []); // do not hammer a failing engine
        return [];
    }
}

module.exports = { ENGINES, engine, searchUrl, classify, suggestions };
