'use strict';
/**
 * SOCKS5 -> HTTP bridge.
 *
 * Rammerhead (testcafe-hammerhead) can only send traffic through HTTP
 * proxies. For each SOCKS5 upstream we therefore start a tiny local HTTP
 * proxy on 127.0.0.1:<random port> that forwards everything through the
 * SOCKS5 server. Rammerhead is pointed at that local bridge.
 *
 *   Rammerhead --HTTP CONNECT--> 127.0.0.1:<port> (bridge) --SOCKS5--> upstream --> website
 *
 * Each bridge requires a random password so other local processes cannot use it.
 * Bridges are created lazily and live for the lifetime of the process.
 */
const http = require('http');
const crypto = require('crypto');
const { openTunnel } = require('../lib/tunnel');
const log = require('../lib/logger')('socks-bridge');

const bridges = new Map(); // key -> Promise<{ port, user, pass, server }>

const keyOf = (p) => `${p.id}|${p.host}|${p.port}|${p.username || ''}|${p.password || ''}`;

/**
 * @param {object} proxy socks5 proxy row (with credentials)
 * @returns {Promise<{ port:number, user:string, pass:string }>}
 */
function getBridge(proxy) {
    const key = keyOf(proxy);
    if (!bridges.has(key)) {
        // Credentials changed for this proxy id -> close the old bridge.
        for (const [k, b] of bridges) {
            if (k.startsWith(`${proxy.id}|`) && k !== key) {
                b.then((x) => x.server.close()).catch(() => {});
                bridges.delete(k);
            }
        }
        bridges.set(key, createBridge(proxy));
    }
    return bridges.get(key);
}

function createBridge(upstream) {
    const user = 'portal';
    const pass = crypto.randomBytes(16).toString('hex');
    const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const authorized = (req) => req.headers['proxy-authorization'] === expected;

    const server = http.createServer();

    // Plain-HTTP requests: "GET http://site/path HTTP/1.1"
    server.on('request', (req, res) => {
        if (!authorized(req)) {
            res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="bridge"' });
            return res.end();
        }
        let target;
        try {
            target = new URL(req.url);
        } catch (_) {
            res.writeHead(400);
            return res.end('absolute URL required');
        }
        const port = Number(target.port) || 80;
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        openTunnel(upstream, target.hostname, port)
            .then((socket) => {
                const out = http.request(
                    {
                        host: target.hostname,
                        port,
                        method: req.method,
                        path: target.pathname + target.search,
                        headers,
                        createConnection: () => socket
                    },
                    (upRes) => {
                        res.writeHead(upRes.statusCode, upRes.rawHeaders);
                        upRes.pipe(res);
                    }
                );
                out.on('error', () => res.destroy());
                req.pipe(out);
            })
            .catch((e) => {
                log.debug(`bridge request failed: ${e.message}`);
                if (!res.headersSent) res.writeHead(502);
                res.end();
            });
    });

    // HTTPS (and websockets over TLS): "CONNECT host:443"
    server.on('connect', (req, clientSocket, head) => {
        if (!authorized(req)) {
            clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="bridge"\r\n\r\n');
            return;
        }
        const [host, portStr] = String(req.url).split(/:(?=\d+$)/);
        openTunnel(upstream, host.replace(/^\[|\]$/g, ''), Number(portStr) || 443)
            .then((upSocket) => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) upSocket.write(head);
                upSocket.pipe(clientSocket);
                clientSocket.pipe(upSocket);
                const destroy = () => {
                    upSocket.destroy();
                    clientSocket.destroy();
                };
                upSocket.on('error', destroy);
                clientSocket.on('error', destroy);
            })
            .catch((e) => {
                log.debug(`bridge CONNECT ${req.url} failed: ${e.message}`);
                clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            log.info(`bridge for socks5 proxy #${upstream.id} listening on 127.0.0.1:${port}`);
            resolve({ port, user, pass, server });
        });
    });
}

function closeAll() {
    for (const b of bridges.values()) b.then((x) => x.server.close()).catch(() => {});
    bridges.clear();
}

module.exports = { getBridge, closeAll };
