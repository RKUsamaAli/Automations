'use strict';
/**
 * Turns what a user typed into a safe http(s) URL (used by the portal's
 * Browse page and the floating toolbar on proxied pages).
 *
 *   normalizeUrl('example.com/path') -> 'https://example.com/path'
 *   rejects other schemes, bare words and private/internal addresses (SSRF)
 */
const { isPrivateHost } = require('./netGuard');

/** Turns "example.com/path" into "https://example.com/path"; rejects non-http(s). */
function normalizeUrl(input) {
    let raw = String(input || '').trim();
    if (!raw) throw new Error('Enter a website address');
    if (raw.length > 4000) throw new Error('URL is too long');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
    let u;
    try {
        u = new URL(raw);
    } catch (_) {
        throw new Error('That does not look like a valid website address');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses are supported');
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a valid website address');
    // Never let users point the proxy at the server itself / private networks.
    if (isPrivateHost(u.hostname)) throw new Error('That address is not allowed');
    return u.toString();
}

module.exports = { normalizeUrl };
