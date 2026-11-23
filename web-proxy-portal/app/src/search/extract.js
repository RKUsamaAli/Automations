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
    // innerText is empty for text the page hides with CSS (Bing does until its scripts run): fall back to textContent
    const txt = (el) => (el ? (el.innerText || '').trim() || el.textContent || '' : '').replace(/\s+/g, ' ').trim();
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
        if (hint) snippet = txt(hint);
        else if (box) snippet = txt(box).replace(txt(h3), '');
        out.push({
            title: txt(h3).slice(0, 200),
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
    // innerText is empty for text the page hides with CSS (Bing does until its scripts run): fall back to textContent
    const txt = (el) => (el ? (el.innerText || '').trim() || el.textContent || '' : '').replace(/\s+/g, ' ').trim();
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
        out.push({ title: txt(a).slice(0, 200), url, displayUrl: host, snippet: txt(sn).slice(0, 300) });
        if (out.length >= 15) break;
    }
    return out;
}

/** Bing (www.bing.com/search). Result links may be bing.com/ck/a?...&u=a1<base64url target>. */
function extractBing() {
    // innerText is empty for text the page hides with CSS (Bing does until its scripts run): fall back to textContent
    const txt = (el) => (el ? (el.innerText || '').trim() || el.textContent || '' : '').replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('#b_results li.b_algo h2 a')) {
        let url = a.href;
        try {
            const u = new URL(url);
            const enc = u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/') ? u.searchParams.get('u') : null;
            if (enc && enc.startsWith('a1')) url = atob(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
        } catch (_) {
            continue;
        }
        if (!/^https?:/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        let host = '';
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch (_) {
            continue;
        }
        const li = a.closest('li.b_algo');
        const sn = li && li.querySelector('.b_caption p, p');
        out.push({ title: txt(a).slice(0, 200), url, displayUrl: host, snippet: txt(sn).slice(0, 300) });
        if (out.length >= 15) break;
    }
    return out;
}

module.exports = { extractGoogle, classifyGoogle, extractDuckDuckGo, extractBing };
