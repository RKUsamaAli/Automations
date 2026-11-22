'use strict';
/**
 * Minimal stand-in for nginx, used when the browser tests start the app
 * themselves (local mode). Routes by Host header exactly like
 * deploy/templates/nginx-*.conf.tpl:
 *
 *   portal.localtest:<mainPort>   -> portal-web   (WEB_PORT)
 *   browse.localtest:<mainPort>   -> portal-proxy (PROXY_PORT)
 *   browse.localtest:<crossPort>  -> portal-proxy (PROXY_CROSS_DOMAIN_PORT)
 *
 * Supports WebSocket upgrades and sets X-Real-IP like nginx does.
 */
const http = require('http');
const net = require('net');

function createGateway({ listenPort, appHost, webPort, proxyPort }) {
    const pickPort = (host) => (String(host || '').split(':')[0] === appHost ? webPort : proxyPort);

    const server = http.createServer((req, res) => {
        const port = pickPort(req.headers.host);
        const headers = { ...req.headers, 'x-real-ip': req.socket.remoteAddress, 'x-forwarded-proto': 'http' };
        const out = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers }, (r) => {
            res.writeHead(r.statusCode, r.rawHeaders);
            r.pipe(res);
        });
        out.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end('gateway: backend unavailable');
        });
        req.pipe(out);
    });

    server.on('upgrade', (req, socket, head) => {
        const port = pickPort(req.headers.host);
        const up = net.connect(port, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            lines.push(`X-Real-IP: ${req.socket.remoteAddress}`);
            up.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
    });

    return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)));
}

module.exports = { createGateway };
