'use strict';
/**
 * Custom JavaScript injected into proxied pages.
 *
 * How it works: every proxied HTML page gets ONE extra <script> tag
 * (/__portal/inject.js) added by Rammerhead's HTML rewriter. That endpoint
 * returns the bundle built by `buildBundle()` below, containing only the
 * scripts whose domain patterns match the page being viewed, in load order.
 *
 * Each script is wrapped so that:
 *   - an error in one script never breaks the page or the other scripts
 *   - it runs at the requested time (document-start / document-end / document-idle)
 *   - it can read `window.__portal.page` = { url, host } (the REAL site URL,
 *     because `location` inside injected code shows the proxy URL)
 */
const db = require('../db');
const TtlCache = require('../lib/ttlCache');
const { parsePatterns, isValidPattern, matchesAny } = require('../lib/domainMatch');

const RUN_AT = ['document-start', 'document-end', 'document-idle'];
const MAX_CODE_BYTES = 200 * 1024; // keep injected code small for mobile
const cache = new TtlCache(10000);

function list() {
    return db.get().prepare('SELECT * FROM scripts ORDER BY load_order, id').all();
}

function listEnabled() {
    return cache.get('enabled', () => db.get().prepare('SELECT * FROM scripts WHERE enabled = 1 ORDER BY load_order, id').all());
}

function save({ id, name, domains = '*', runAt = 'document-end', loadOrder = 100, enabled = true, code }) {
    if (!name || String(name).length > 80) throw new Error('Script name is required (max 80 chars)');
    if (!RUN_AT.includes(runAt)) throw new Error(`run_at must be one of ${RUN_AT.join(', ')}`);
    const patterns = parsePatterns(domains);
    if (!patterns.length) throw new Error('At least one domain pattern is required (use * for all sites)');
    const bad = patterns.filter((p) => !isValidPattern(p));
    if (bad.length) throw new Error(`Invalid domain pattern(s): ${bad.join(', ')}`);
    if (!code || !String(code).trim()) throw new Error('Script code is required');
    if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new Error('Script is larger than 200 KB');
    // Syntax check now, so a typo can't silently break injection later.
    try {
        // eslint-disable-next-line no-new-func
        new Function(code);
    } catch (e) {
        throw new Error(`JavaScript syntax error: ${e.message}`);
    }
    const now = Date.now();
    const conn = db.get();
    let scriptId = id;
    if (id) {
        conn.prepare('UPDATE scripts SET name = ?, domains = ?, run_at = ?, load_order = ?, enabled = ?, code = ?, updated_at = ? WHERE id = ?').run(
            name,
            patterns.join(','),
            runAt,
            Number(loadOrder) || 0,
            enabled ? 1 : 0,
            code,
            now,
            id
        );
    } else {
        scriptId = conn
            .prepare('INSERT INTO scripts (name, domains, run_at, load_order, enabled, code, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(name, patterns.join(','), runAt, Number(loadOrder) || 0, enabled ? 1 : 0, code, now, now).lastInsertRowid;
    }
    cache.clear();
    return conn.prepare('SELECT * FROM scripts WHERE id = ?').get(scriptId);
}

function setEnabled(id, enabled) {
    db.get().prepare('UPDATE scripts SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
    cache.clear();
}

function remove(id) {
    db.get().prepare('DELETE FROM scripts WHERE id = ?').run(id);
    cache.clear();
}

/**
 * Builds the JS bundle for one page.
 * @param {string} pageUrl real destination URL, e.g. https://www.example.com/login
 * @param {string} host    its hostname
 * @param {object[]} [scriptsList] defaults to the enabled scripts
 */
function buildBundle(pageUrl, host, scriptsList = listEnabled()) {
    // Unknown page (browser sent no Referer): only scripts meant for ALL sites ("*") run.
    const matching = host
        ? scriptsList.filter((s) => matchesAny(host, s.domains))
        : scriptsList.filter((s) => parsePatterns(s.domains).includes('*'));
    const pageInfo = JSON.stringify({ url: pageUrl || null, host: host || null });
    if (!matching.length) {
        return `/* portal: no scripts for this page */\n(window.__portal = window.__portal || {}).page = ${pageInfo};\n`;
    }
    const parts = [
        '/* portal injected scripts - generated, do not edit */',
        '(function () {',
        '  var P = window.__portal = window.__portal || {};',
        `  P.page = ${pageInfo};`,
        '  function safe(name, fn) { try { fn(); } catch (e) { if (window.console) console.warn("[portal script " + name + "]", e); } }',
        '  function when(runAt, name, fn) {',
        '    if (runAt === "document-start") return safe(name, fn);',
        '    var go = function () { runAt === "document-idle" ? setTimeout(function () { safe(name, fn); }, 0) : safe(name, fn); };',
        '    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go, { once: true });',
        '    else go();',
        '  }'
    ];
    for (const s of matching) {
        parts.push(`  // ---- ${s.name.replace(/[\r\n]/g, ' ')} (#${s.id}) ----`);
        parts.push(`  when(${JSON.stringify(s.run_at)}, ${JSON.stringify(s.name)}, function () {\n${s.code}\n  });`);
    }
    parts.push('})();');
    return parts.join('\n') + '\n';
}

module.exports = { RUN_AT, list, listEnabled, save, setEnabled, remove, buildBundle, clearCache: () => cache.clear() };
