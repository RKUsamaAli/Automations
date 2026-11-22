'use strict';
/**
 * Functions that run INSIDE the headless browser page (page.evaluate), so
 * they must be self-contained (no closures over Node variables).
 *
 * Google: results are links wrapped around an <h3> title inside #search /
 * #rso. That structure has been stable for years; class names are not, so
 * they are only used as optional hints for the snippet.
 */

/* eslint-disable no-undef */
function extractGoogle() {
    const out = [];
    const seen = new Set();
    const scope = document.querySelector('#search') || document.querySelector('#rso') || document.body;
    const unwrap = (href) => {
        try {
            const u = new URL(href, location.href);
            // /url?q=<target>  (older / no-JS result links)
            if (u.pathname === '/url' && (u.origin === location.origin || /(^|\.)google\./.test(u.hostname))) return u.searchParams.get('q') || u.searchParams.get('url');
            return u.href;
        } catch (_) {
            return null;
        }
    };
    for (const h3 of scope.querySelectorAll('a h3, a [role="heading"]')) {
        const a = h3.closest('a');
        const url = a && unwrap(a.getAttribute('href') || '');
        if (!url || !/^https?:/i.test(url)) continue;
        let host;
        try {
            host = new URL(url).hostname;
        } catch (_) {
            continue;
        }
        if (/(^|\.)google\.[a-z.]+$/.test(host) && !/^(maps|play|books|scholar|support|developers)\./.test(host)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        const box = a.closest('[data-hveid], .g, .MjjYud, [data-sokoban-container]') || a.parentElement;
        let snippet = '';
        const hint = box && box.querySelector('[data-sncf], .VwiC3b, [style*="line-clamp"], [data-content-feature]');
        if (hint) snippet = hint.innerText;
        else if (box) snippet = box.innerText.replace(h3.innerText, '');
        out.push({
            title: h3.innerText.trim().slice(0, 200),
            url,
            displayUrl: host.replace(/^www\./, ''),
            snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 300)
        });
        if (out.length >= 15) break;
    }
    return out;
}

/** What kind of Google page is this? captcha | consent | results | unknown */
function classifyGoogle() {
    const u = location.href;
    if (/\/sorry\//.test(u) || document.querySelector('#captcha-form, form[action*="sorry"]')) return 'captcha';
    if (/consent\.google\./.test(u) || document.querySelector('form[action*="consent"]')) return 'consent';
    if (document.querySelector('#search, #rso')) return 'results';
    return 'unknown';
}

/** DuckDuckGo HTML version (html.duckduckgo.com/html/). */
function extractDuckDuckGo() {
    const out = [];
    for (const r of document.querySelectorAll('.result')) {
        if (r.classList.contains('result--ad')) continue;
        const a = r.querySelector('a.result__a');
        if (!a) continue;
        let url = a.href;
        try {
            const u = new URL(url);
            if (u.searchParams.get('uddg')) url = u.searchParams.get('uddg'); // DDG redirect link
        } catch (_) {
            continue;
        }
        if (!/^https?:/i.test(url)) continue;
        const sn = r.querySelector('.result__snippet');
        let host = '';
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch (_) {
            /* keep empty */
        }
        out.push({ title: a.innerText.trim().slice(0, 200), url, displayUrl: host, snippet: sn ? sn.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '' });
        if (out.length >= 15) break;
    }
    return out;
}

module.exports = { extractGoogle, classifyGoogle, extractDuckDuckGo };
