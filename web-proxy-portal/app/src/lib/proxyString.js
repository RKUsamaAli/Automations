'use strict';
/**
 * Parses upstream proxy lines pasted by the admin.
 *
 * Supported formats (one per line, blank lines and # comments ignored):
 *   http://user:pass@1.2.3.4:8080
 *   https://user:pass@1.2.3.4:8080      (treated as http CONNECT proxy)
 *   socks5://user:pass@1.2.3.4:1080
 *   1.2.3.4:8080:user:pass              (Webshare "download list" format, default protocol)
 *   1.2.3.4:8080                        (no auth, default protocol)
 */

const SUPPORTED = ['http', 'socks5'];

/** The line with its password hidden, for error messages shown to users. */
function mask(raw) {
    if (raw.includes('://')) return raw.replace(/(:\/\/[^:@/]*:)[^@/]*@/, '$1***@');
    const parts = raw.split(':');
    return parts.length >= 4 ? [...parts.slice(0, 3), '***'].join(':') : raw;
}

function parseProxyLine(line, defaultProtocol = 'http') {
    const raw = String(line || '').trim();
    if (!raw || raw.startsWith('#')) return null;

    if (raw.includes('://')) {
        let u;
        try {
            u = new URL(raw);
        } catch (_) {
            throw new Error(`Invalid proxy URL: ${mask(raw)}`);
        }
        let protocol = u.protocol.replace(':', '').toLowerCase();
        if (protocol === 'https') protocol = 'http';
        if (protocol === 'socks5h' || protocol === 'socks') protocol = 'socks5';
        if (!SUPPORTED.includes(protocol)) throw new Error(`Unsupported proxy protocol "${protocol}" in: ${mask(raw)}`);
        // The URL parser drops a port that is the scheme's default (http://...:80,
        // https://...:443), so read the port the user actually typed.
        const authority = raw.split('://')[1].split(/[/?#]/)[0];
        const typedPort = /:(\d{1,5})$/.exec(authority.slice(authority.lastIndexOf('@') + 1));
        const port = Number(u.port) || (typedPort ? Number(typedPort[1]) : 0);
        if (!u.hostname || !port || port > 65535) throw new Error(`Proxy needs host and port: ${mask(raw)}`);
        return {
            protocol,
            host: u.hostname.replace(/^\[|\]$/g, ''),
            port,
            username: u.username ? decodeURIComponent(u.username) : null,
            password: u.password ? decodeURIComponent(u.password) : null
        };
    }

    // host:port[:user:pass]
    const parts = raw.split(':');
    if (parts.length !== 2 && parts.length < 4) throw new Error(`Unrecognised proxy format: ${mask(raw)}`);
    const [host, portStr, username, ...rest] = parts;
    const port = Number(portStr);
    if (!host || !port || port > 65535) throw new Error(`Invalid host/port in: ${mask(raw)}`);
    return {
        protocol: SUPPORTED.includes(defaultProtocol) ? defaultProtocol : 'http',
        host,
        port,
        username: username || null,
        password: rest.length ? rest.join(':') : null
    };
}

/** @returns {{ proxies: object[], errors: string[] }} */
function parseProxyList(text, defaultProtocol = 'http') {
    const proxies = [];
    const errors = [];
    String(text || '')
        .split(/\r?\n/)
        .forEach((line, i) => {
            try {
                const p = parseProxyLine(line, defaultProtocol);
                if (p) proxies.push(p);
            } catch (e) {
                errors.push(`Line ${i + 1}: ${e.message}`);
            }
        });
    return { proxies, errors };
}

/** Safe display string (password masked). */
function describeProxy(p) {
    const auth = p.username ? `${p.username}:***@` : '';
    return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

module.exports = { parseProxyLine, parseProxyList, describeProxy, SUPPORTED };
