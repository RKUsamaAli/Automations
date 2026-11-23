'use strict';
/**
 * Egress guard for the live browser: a tiny HTTP proxy on 127.0.0.1 that
 * every request of the server's Chromium goes through (--proxy-server, with
 * loopback NOT bypassed). It refuses private / internal destinations so a
 * user cannot reach the server's own services (127.0.0.1:3000, the cloud
 * metadata service 169.254.169.254, the LAN ...), and it connects to the IP
 * it checked (no DNS-rebinding window).
 *
 * Supports CONNECT (https, wss) and absolute-URL requests (http, ws).
 * Later: this is also where an upstream proxy per user can be chained in.
 *
 * Test servers only: LIVE_RESOLVE="shop.localtest=127.0.0.1:17001,..." maps
 * names to a fixed address (with ALLOW_PRIVATE_UPSTREAMS=true).
 */
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { isPrivateIp, isPrivateHost } = require('../lib/netGuard');
const log = require('../lib/logger')('live-egress');

const allowPrivate = () => process.env.ALLOW_PRIVATE_UPSTREAMS === 'true';

/** Optional upstream HTTP proxy for everything (LIVE_UPSTREAM_PROXY=http://user:pass@host:port). */
function upstream() {
    const v = process.env.LIVE_UPSTREAM_PROXY;
    if (!v) return null;
    try {
        const u = new URL(v);
        const auth = u.username ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null;
        return { host: u.hostname, port: Number(u.port) || 80, auth };
    } catch (_) {
        return null;
    }
}

/** Opens a TCP tunnel to host:port, directly or through the upstream proxy. */
function tunnel(dest, hostname, port, cb) {
    const up = upstream();
    if (!up) {
        const s = net.connect(dest.port, dest.host, () => cb(null, s));
        s.on('error', (e) => cb(e));
        return s;
    }
    const s = net.connect(up.port, up.host, () => {
        s.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${up.auth ? `Proxy-Authorization: ${up.auth}\r\n` : ''}\r\n`);
        let buf = Buffer.alloc(0);
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            const end = buf.indexOf('\r\n\r\n');
            if (end === -1) return;
            s.removeListener('data', onData);
            const ok = /^HTTP\/1\.[01] 200/.test(buf.slice(0, 20).toString('latin1'));
            if (!ok) return cb(new Error('upstream proxy refused: ' + buf.slice(0, buf.indexOf('\r\n')).toString('latin1')));
            const rest = buf.slice(end + 4);
            if (rest.length) s.unshift(rest);
            cb(null, s);
        };
        s.on('data', onData);
    });
    s.on('error', (e) => cb(e));
    return s;
}

function testMap() {
    const out = new Map();
    for (const part of String(process.env.LIVE_RESOLVE || '').split(',')) {
        const m = /^\s*([^=\s]+)=([^:\s]+):(\d+)\s*$/.exec(part);
        if (m) out.set(m[1].toLowerCase(), { host: m[2], port: Number(m[3]) });
    }
    return out;
}

/** -> { host, port } to connect to, or throws (blocked / does not resolve). */
async function resolveTarget(hostname, port) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = testMap().get(h);
    if (mapped) return mapped;
    if (!port || port < 1 || port > 65535) throw new Error('bad port');
    if (!allowPrivate() && isPrivateHost(h)) throw Object.assign(new Error(`${h} is a private address`), { blocked: true });
    if (net.isIP(h) || upstream()) return { host: h, port }; // with an upstream proxy, it resolves the name
    let addrs;
    try {
        addrs = await dns.lookup(h, { all: true });
    } catch (_) {
        throw new Error(`${h} does not resolve`);
    }
    if (!addrs.length) throw new Error(`${h} does not resolve`);
    if (!allowPrivate()) {
        const bad = addrs.find((a) => isPrivateIp(a.address));
        if (bad) throw Object.assign(new Error(`${h} resolves to a private address`), { blocked: true });
    }
    const v4 = addrs.find((a) => a.family === 4) || addrs[0];
    return { host: v4.address, port };
}

/**
 * @param {{ onBlocked?: (host:string, reason:string) => void }} [opts]
 * @returns {Promise<{ port:number, close:() => void }>}
 */
function start({ onBlocked } = {}) {
    const blocked = (host, e) => {
        if (e && e.blocked && onBlocked) onBlocked(host, e.message);
    };
    const server = http.createServer(async (req, res) => {
        // absolute-URL request (plain http)
        let u;
        try {
            u = new URL(req.url);
        } catch (_) {
            res.writeHead(400);
            return res.end();
        }
        let dest;
        try {
            dest = await resolveTarget(u.hostname, Number(u.port) || 80);
        } catch (e) {
            blocked(u.hostname, e);
            res.writeHead(e.blocked ? 403 : 502, { 'content-type': 'text/plain' });
            return res.end(e.blocked ? 'Blocked: private address' : e.message);
        }
        const headers = { ...req.headers };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        const out = http.request({ host: dest.host, port: dest.port, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
            res.writeHead(r.statusCode, r.rawHeaders);
            r.pipe(res);
        });
        out.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        req.pipe(out);
    });
    // https / wss tunnels
    server.on('connect', async (req, sock, head) => {
        sock.on('error', () => {});
        const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
        if (!m) return sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        let dest;
        try {
            dest = await resolveTarget(m[1], Number(m[2]));
        } catch (e) {
            blocked(m[1], e);
            return sock.end(`HTTP/1.1 ${e.blocked ? 403 : 502} ${e.blocked ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`);
        }
        let done = false;
        const up = tunnel(dest, m[1], Number(m[2]), (err, conn) => {
            if (done) return;
            done = true;
            if (err) return sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            conn.setNoDelay(true);
            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) conn.write(head);
            conn.pipe(sock);
            sock.pipe(conn);
            conn.on('error', () => sock.destroy());
        });
        sock.on('close', () => up.destroy());
    });
    // ws:// upgrades through an absolute-URL request
    server.on('upgrade', async (req, sock, head) => {
        sock.on('error', () => {});
        let u;
        try {
            u = new URL(req.url);
        } catch (_) {
            return sock.destroy();
        }
        let dest;
        try {
            dest = await resolveTarget(u.hostname, Number(u.port) || 80);
        } catch (e) {
            blocked(u.hostname, e);
            return sock.destroy();
        }
        const up = net.connect(dest.port, dest.host, () => {
            const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            up.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(sock);
            sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
        sock.on('close', () => up.destroy());
    });
    server.on('clientError', (_e, sock) => sock.destroy());
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            log.info(`egress guard on 127.0.0.1:${port}${allowPrivate() ? ' (private addresses ALLOWED - test server)' : ''}`);
            resolve({ port, close: () => server.close() });
        });
    });
}

module.exports = { start, resolveTarget };
