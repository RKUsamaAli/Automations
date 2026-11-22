'use strict';
/**
 * Domain pattern matching used by the allowlist, site rules and script rules.
 *
 * Pattern syntax (case-insensitive):
 *   example.com        -> exactly example.com
 *   *.example.com      -> example.com AND any subdomain (www.example.com, a.b.example.com)
 *   *                  -> everything
 *
 * Patterns can be passed as an array or a comma/newline separated string.
 */

function normalizeHost(host) {
    return String(host || '')
        .trim()
        .toLowerCase()
        .replace(/\.$/, '') // trailing dot
        .replace(/:\d+$/, ''); // port
}

function parsePatterns(patterns) {
    if (!patterns) return [];
    const list = Array.isArray(patterns) ? patterns : String(patterns).split(/[\s,]+/);
    return list.map((p) => String(p).trim().toLowerCase()).filter(Boolean);
}

function matchesPattern(host, pattern) {
    host = normalizeHost(host);
    pattern = String(pattern).trim().toLowerCase();
    if (!host || !pattern) return false;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host === base || host.endsWith('.' + base);
    }
    return host === pattern;
}

function matchesAny(host, patterns) {
    return parsePatterns(patterns).some((p) => matchesPattern(host, p));
}

/** Validates a single pattern for admin input. */
function isValidPattern(pattern) {
    return /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(String(pattern).trim());
}

/** Returns the hostname of an http(s) URL or null. */
function hostOf(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return normalizeHost(u.hostname);
    } catch (_) {
        return null;
    }
}

module.exports = { normalizeHost, parsePatterns, matchesPattern, matchesAny, isValidPattern, hostOf };
