'use strict';
/**
 * Fake outside world for the browser tests.
 *
 *  1. TARGET SITE  "shop.localtest"  - a tiny demo shop with a login form and a
 *     cookie session, so the tests prove that logins work THROUGH the proxy.
 *     It prints which upstream proxy the request came through.
 *  2. UPSTREAM PROXIES  - HTTP proxies (absolute-URL + CONNECT) that require a
 *     username/password, resolve *.localtest to the target site and stamp
 *     "X-Via-Upstream: <name>" on what they forward. One plays the admin's
 *     provider, the other a user's own proxy.
 *
 * Nothing here talks to the internet.
 */
const http = require('http');
const net = require('net');

const page = (title, body, via) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
 body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#fff8f1;color:#2b2118}
 header{background:#d9480f;color:#fff;padding:14px 18px;font-weight:700;font-size:20px}
 main{max-width:560px;margin:0 auto;padding:18px}
 .card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.06);margin-bottom:14px}
 input{width:100%;box-sizing:border-box;padding:11px;font-size:16px;margin:6px 0 12px;border:1px solid #e3d6c8;border-radius:9px}
 button,.btn{background:#d9480f;color:#fff;border:0;border-radius:9px;padding:11px 16px;font-size:16px;font-weight:600;display:inline-block;text-decoration:none}
 .via{font-size:13px;color:#8a6d55}
 .products{display:grid;grid-template-columns:1fr 1fr;gap:10px}.p{background:#fff;border-radius:12px;padding:12px;text-align:center}.p b{display:block;font-size:28px}
</style></head><body><header>Demo Shop</header><main>${body}
<p class="via" id="via">Connected via upstream: <strong id="via-name">${via || 'direct'}</strong></p></main></body></html>`;

function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
}

function startTargetSite(port) {
    const sessions = new Map();
    const server = http.createServer((req, res) => {
        const via = req.headers['x-via-upstream'] || null;
        const url = new URL(req.url, 'http://shop.localtest');
        const sid = parseCookies(req.headers.cookie).shop_session;
        const user = sid && sessions.get(sid);

        if (url.pathname === '/204') {
            res.writeHead(204);
            return res.end();
        }
        // Fake IP-info service (EXIT_IP_CHECK_URL=http://ip.localtest/ip): answers like ipwho.is,
        // with a different exit IP / location per fake upstream proxy.
        if (url.pathname === '/ip') {
            const own = via === 'Your own proxy';
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(own
                ? { ip: '203.0.113.20', country: 'Spain', country_code: 'ES', city: 'Madrid', timezone: { id: 'Europe/Madrid' }, connection: { isp: 'Demo Telecom ES' } }
                : { ip: '198.51.100.10', country: 'United States', country_code: 'US', city: 'New York', timezone: { id: 'America/New_York' }, connection: { isp: 'Demo Hosting US' } }));
        }
        // Fake search engine (Admin -> Settings -> Search -> Custom) for the address-bar test.
        if (url.pathname === '/suggest') {
            const q = url.searchParams.get('q') || '';
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify([q, [`${q} recipes`, `${q} prices`, `${q} delivery`]]));
        }
        // Fake Google results page (GOOGLE_SEARCH_URL=http://google.localtest/google?q={q}),
        // read by the server's search browser: result links are <a><h3> inside #search.
        if (url.pathname === '/google') {
            const q = (url.searchParams.get('q') || '').replace(/[<>&"]/g, '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(`<!doctype html><title>${q} - Google</title><div id="search">
<div class="g"><a href="http://shop.localtest/"><h3>Demo Shop - fresh ${q}</h3></a><div class="VwiC3b">Fresh ${q} delivered today. Seen via ${via || 'direct'}.</div></div>
<div class="g"><a href="/url?q=http://shop.localtest/login&sa=U"><h3>Sign in to Demo Shop</h3></a><div class="VwiC3b">Your orders and account.</div></div></div>`);
        }
        if (url.pathname === '/search') {
            const q = (url.searchParams.get('q') || '').replace(/[<>&"]/g, '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(page(`${q} - Demo Search`, `<div class="card"><h2 id="search-title">Results for "${q}"</h2>
<ol class="results"><li><a id="result-1" href="/">Demo Shop - fresh ${q}</a><p>Fresh picks delivered today.</p></li>
<li><a href="/login">Sign in to Demo Shop</a><p>Your orders and account.</p></li></ol></div>`, via));
        }
        if (url.pathname === '/login' && req.method === 'POST') {
            let body = '';
            req.on('data', (d) => (body += d));
            req.on('end', () => {
                const form = new URLSearchParams(body);
                if (form.get('password') !== 'shop-pass') {
                    res.writeHead(401, { 'content-type': 'text/html' });
                    return res.end(page('Login failed', '<div class="card"><h2>Wrong password</h2><a class="btn" href="/login">Try again</a></div>', via));
                }
                const id = Math.random().toString(36).slice(2);
                sessions.set(id, form.get('username') || 'customer');
                res.writeHead(302, { location: '/account', 'set-cookie': `shop_session=${id}; Path=/; HttpOnly` });
                res.end();
            });
            return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (url.pathname === '/login') {
            return res.end(page('Sign in - Demo Shop', `<div class="card"><h2>Sign in</h2><form method="post" action="/login">
<label>Username<input name="username" id="shop-user" autocomplete="off"></label>
<label>Password<input name="password" id="shop-pass" type="password"></label>
<button type="submit" id="shop-login">Sign in</button></form></div>`, via));
        }
        if (url.pathname === '/account') {
            if (!user) {
                res.writeHead(302, { location: '/login' });
                return res.end();
            }
            return res.end(page('My account - Demo Shop', `<div class="card"><h2 id="welcome">Welcome back, ${user.replace(/[<>&"]/g, '')}!</h2>
<p>You are signed in. This login lives in the portal's server-side session.</p><a class="btn" href="/">Continue shopping</a></div>`, via));
        }
        return res.end(page('Demo Shop', `<div class="card"><h2 id="shop-title">Fresh picks today</h2><p>${user ? 'Signed in as ' + user : 'Browse our products or <a href="/login">sign in</a>.'}</p></div>
<div class="products"><div class="p"><b>🍋</b>Lemons<br>$2</div><div class="p"><b>🥑</b>Avocado<br>$3</div><div class="p"><b>🍓</b>Berries<br>$4</div><div class="p"><b>🥖</b>Bread<br>$5</div></div>`, via));
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/**
 * @param {{ port:number, name:string, user:string, pass:string, sitePort:number }} o
 */
function startUpstreamProxy({ port, name, user, pass, sitePort }) {
    const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const route = (host, p) => (/\.localtest$/i.test(host) ? { host: '127.0.0.1', port: sitePort } : { host, port: p });
    const server = http.createServer((req, res) => {
        if (req.headers['proxy-authorization'] !== expected) {
            res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake"' });
            return res.end();
        }
        let target;
        try {
            target = new URL(req.url);
        } catch (_) {
            res.writeHead(400);
            return res.end();
        }
        // A site behind this proxy that always drops the connection (error-reporting scenario)
        if (target.hostname === 'broken.localtest') return req.socket.destroy();
        const dest = route(target.hostname, Number(target.port) || 80);
        const headers = { ...req.headers, host: target.host, 'x-via-upstream': name };
        delete headers['proxy-authorization'];
        const out = http.request({ host: dest.host, port: dest.port, method: req.method, path: target.pathname + target.search, headers }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        out.on('error', () => {
            res.writeHead(502);
            res.end();
        });
        req.pipe(out);
    });
    server.on('connect', (req, sock, head) => {
        if (req.headers['proxy-authorization'] !== expected) return sock.end('HTTP/1.1 407 Auth\r\n\r\n');
        const [h, p] = req.url.split(':');
        const dest = route(h, Number(p));
        const up = net.connect(dest.port, dest.host, () => {
            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(sock);
            if (Number(p) === 80) {
                // plain HTTP through the tunnel (e.g. the exit-IP check): tag the first
                // request with this proxy's name, like the forward path does
                let first = true;
                sock.on('data', (d) => {
                    if (first) {
                        first = false;
                        const s = d.toString('latin1');
                        const i = s.indexOf('\r\n');
                        if (i > 0) return up.write(Buffer.from(s.slice(0, i + 2) + `x-via-upstream: ${name}\r\n` + s.slice(i + 2), 'latin1'));
                    }
                    up.write(d);
                });
                sock.on('end', () => up.end());
            } else sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
        sock.on('error', () => up.destroy());
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { startTargetSite, startUpstreamProxy };
