'use strict';
/**
 * Tunnels + health check + SOCKS bridge against local fake proxies.
 */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { openTunnel } = require('../src/lib/tunnel');
const { probe } = require('../src/jobs/healthCheck');
const socksBridge = require('../src/proxy/socksBridge');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

let targetPort;
let httpProxyPort;
let socksPort;
const servers = [];

test.before(async () => {
    // Destination "website"
    const target = http.createServer((req, res) => {
        res.writeHead(req.url === '/204' ? 204 : 200, { 'content-type': 'text/plain' });
        res.end(req.method === 'HEAD' ? undefined : 'hello from target');
    });
    targetPort = await listen(target);
    servers.push(target);

    // Fake HTTP CONNECT proxy requiring Basic auth user:pass
    const proxy = http.createServer();
    proxy.on('connect', (req, sock) => {
        if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('user:pass').toString('base64')) {
            return sock.end('HTTP/1.1 407 Auth\r\n\r\n');
        }
        const [host, port] = req.url.split(':');
        const up = net.connect(Number(port), host, () => {
            sock.write('HTTP/1.1 200 OK\r\n\r\n');
            up.pipe(sock);
            sock.pipe(up);
        });
    });
    httpProxyPort = await listen(proxy);
    servers.push(proxy);

    // Minimal SOCKS5 server (username/password auth "u"/"p")
    const socks = net.createServer((sock) => {
        let stage = 0;
        sock.on('data', function onData(buf) {
            if (stage === 0) {
                sock.write(Buffer.from([5, 2])); // choose user/pass auth
                stage = 1;
            } else if (stage === 1) {
                const ulen = buf[1];
                const user = buf.slice(2, 2 + ulen).toString();
                const plen = buf[2 + ulen];
                const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
                sock.write(Buffer.from([1, user === 'u' && pass === 'p' ? 0 : 1]));
                stage = 2;
            } else if (stage === 2) {
                sock.removeListener('data', onData);
                let host;
                let off;
                if (buf[3] === 1) {
                    host = Array.from(buf.slice(4, 8)).join('.');
                    off = 8;
                } else {
                    const len = buf[4];
                    host = buf.slice(5, 5 + len).toString();
                    off = 5 + len;
                }
                const port = buf.readUInt16BE(off);
                const up = net.connect(port, host, () => {
                    sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    up.pipe(sock);
                    sock.pipe(up);
                });
            }
        });
    });
    socksPort = await listen(socks);
    servers.push(socks);
});

test.after(() => {
    socksBridge.closeAll();
    for (const s of servers) s.close();
});

test('HTTP CONNECT tunnel with auth', async () => {
    const sock = await openTunnel({ protocol: 'http', host: '127.0.0.1', port: httpProxyPort, username: 'user', password: 'pass' }, '127.0.0.1', targetPort);
    const data = await new Promise((resolve) => {
        let buf = '';
        sock.on('data', (d) => (buf += d));
        sock.on('end', () => resolve(buf));
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    assert.match(data, /hello from target/);
});

test('HTTP CONNECT tunnel rejects bad credentials', async () => {
    await assert.rejects(openTunnel({ protocol: 'http', host: '127.0.0.1', port: httpProxyPort, username: 'user', password: 'bad' }, '127.0.0.1', targetPort), /407/);
});

test('health probe: healthy via http and socks5 proxies, failure on dead proxy', async () => {
    const url = `http://127.0.0.1:${targetPort}/204`;
    const ok = await probe({ protocol: 'http', host: '127.0.0.1', port: httpProxyPort, username: 'user', password: 'pass' }, { url, timeoutMs: 3000 });
    assert.equal(ok.ok, true, ok.error);
    assert.ok(ok.latencyMs >= 0);
    const okSocks = await probe({ protocol: 'socks5', host: '127.0.0.1', port: socksPort, username: 'u', password: 'p' }, { url, timeoutMs: 3000 });
    assert.equal(okSocks.ok, true, okSocks.error);
    const dead = await probe({ protocol: 'http', host: '127.0.0.1', port: 1, username: null }, { url, timeoutMs: 2000 });
    assert.equal(dead.ok, false);
});

test('SOCKS5 bridge exposes an authenticated local HTTP proxy', async () => {
    const bridge = await socksBridge.getBridge({ id: 99, protocol: 'socks5', host: '127.0.0.1', port: socksPort, username: 'u', password: 'p' });
    // CONNECT through the bridge (what hammerhead does for https)
    const sock = await openTunnel({ protocol: 'http', host: '127.0.0.1', port: bridge.port, username: bridge.user, password: bridge.pass }, '127.0.0.1', targetPort);
    const data = await new Promise((resolve) => {
        let buf = '';
        sock.on('data', (d) => (buf += d));
        sock.on('end', () => resolve(buf));
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    assert.match(data, /hello from target/);
    // plain-http absolute-URL request through the bridge (what hammerhead does for http)
    const body = await new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port: bridge.port, path: `http://127.0.0.1:${targetPort}/`, headers: { 'proxy-authorization': 'Basic ' + Buffer.from(`${bridge.user}:${bridge.pass}`).toString('base64') } },
            (res) => {
                let b = '';
                res.on('data', (d) => (b += d));
                res.on('end', () => resolve(b));
            }
        );
        req.on('error', reject);
        req.end();
    });
    assert.equal(body, 'hello from target');
    // without the bridge password -> 407
    await assert.rejects(openTunnel({ protocol: 'http', host: '127.0.0.1', port: bridge.port }, '127.0.0.1', targetPort), /407/);
});
