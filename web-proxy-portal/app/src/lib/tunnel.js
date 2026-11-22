'use strict';
/**
 * Opens a raw TCP tunnel to host:port THROUGH an upstream proxy.
 * Used by:
 *   - the proxy health checker (src/jobs/healthCheck.js)
 *   - the SOCKS5 bridge        (src/proxy/socksBridge.js)
 *
 * HTTP proxies use the CONNECT method; SOCKS5 proxies use the `socks` package.
 */
const net = require('net');
const { SocksClient } = require('socks');

/**
 * @param {{protocol:'http'|'socks5', host:string, port:number, username?:string, password?:string}} proxy
 * @param {string} host  destination host
 * @param {number} port  destination port
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>}
 */
function openTunnel(proxy, host, port, timeoutMs = 10000) {
    if (proxy.protocol === 'socks5') return openSocksTunnel(proxy, host, port, timeoutMs);
    return openHttpConnectTunnel(proxy, host, port, timeoutMs);
}

async function openSocksTunnel(proxy, host, port, timeoutMs) {
    const { socket } = await SocksClient.createConnection({
        proxy: {
            host: proxy.host,
            port: Number(proxy.port),
            type: 5,
            userId: proxy.username || undefined,
            password: proxy.password || undefined
        },
        command: 'connect',
        destination: { host, port: Number(port) },
        timeout: timeoutMs
    });
    return socket;
}

function openHttpConnectTunnel(proxy, host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxy.host, port: Number(proxy.port) });
        let settled = false;
        let buffer = Buffer.alloc(0);

        const fail = (err) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(err);
        };
        socket.setTimeout(timeoutMs, () => fail(new Error(`proxy timeout after ${timeoutMs}ms`)));
        socket.once('error', fail);
        socket.once('close', () => fail(new Error('proxy closed the connection')));

        socket.once('connect', () => {
            const headers = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
            if (proxy.username) {
                const auth = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
                headers.push(`Proxy-Authorization: Basic ${auth}`);
            }
            socket.write(headers.join('\r\n') + '\r\n\r\n');
        });

        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) {
                if (buffer.length > 16384) fail(new Error('proxy sent oversized CONNECT response'));
                return;
            }
            socket.removeListener('data', onData);
            const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString();
            const status = Number((statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1]);
            if (status !== 200) return fail(new Error(`proxy CONNECT failed: ${statusLine}`));
            settled = true;
            socket.setTimeout(0);
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
            // Anything after the header block already belongs to the tunnel.
            const rest = buffer.slice(end + 4);
            if (rest.length) socket.unshift(rest);
            resolve(socket);
        };
        socket.on('data', onData);
    });
}

module.exports = { openTunnel };
