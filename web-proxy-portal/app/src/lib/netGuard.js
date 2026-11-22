'use strict';
/**
 * Network safety checks (SSRF protection).
 *
 * Used for:
 *   - start URLs typed by users          (portal: /api/portal/browse)
 *   - navigations inside a proxied page   (proxy guard)
 *   - upstream proxies added by USERS     (a user must not be able to make the
 *                                          server connect to 127.0.0.1:3000 etc.)
 *
 * ALLOW_PRIVATE_UPSTREAMS=true disables the check for user proxies. It exists
 * ONLY for automated tests that run a fake upstream proxy on 127.0.0.1.
 */
const dns = require('dns').promises;
const net = require('net');
const config = require('../config');

function isPrivateIp(ip) {
    const h = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(h)) {
        const [a, b] = h.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (net.isIPv6(h)) {
        if (h.startsWith('::ffff:')) return isPrivateIp(h.slice(7));
        return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
    }
    return false;
}

/** Literal check: private IPs, localhost-style names and our own hostnames. */
function isPrivateHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
    if (h === config.appDomain || h === config.proxyDomain) return true;
    return isPrivateIp(h);
}

/** Resolves the host and throws if it is (or resolves to) a private address. */
async function assertPublicHost(host) {
    if (process.env.ALLOW_PRIVATE_UPSTREAMS === 'true') return;
    if (isPrivateHost(host)) throw new Error(`${host} is a private or reserved address`);
    if (net.isIP(host)) return;
    let addrs;
    try {
        addrs = await dns.lookup(host, { all: true });
    } catch (_) {
        throw new Error(`${host} does not resolve`);
    }
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad) throw new Error(`${host} resolves to a private address (${bad.address})`);
}

module.exports = { isPrivateIp, isPrivateHost, assertPublicHost };
