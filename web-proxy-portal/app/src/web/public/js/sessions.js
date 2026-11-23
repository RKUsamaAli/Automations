/* Sessions page: open browsing sessions - resume, change proxy, end. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var goError = P.$('#go-error');
    function hostOf(url) {
        try { return new URL(url).hostname; } catch (_) { return url || '-'; }
    }
    async function browse(body, button) {
        var done = P.busy(button, 'Opening');
        P.showError(goError, '');
        try {
            var res = await P.api('POST', '/api/portal/browse', body);
            location.href = res.redirect;
        } catch (err) {
            P.showError(goError, err.message);
            done();
        }
    }

    /** "● yneehewk-ES-19 @ p.webshare.io:80 · 2.2 s · My proxies" */
    function proxyLabel(x) { return (x.username ? x.username + ' @ ' : '') + x.host + ':' + x.port; }
    function latency(ms) { return ms == null ? '' : ms >= 1000 ? (Math.round(ms / 100) / 10) + ' s' : ms + ' ms'; }
    function proxyBadge(s) {
        if (!s.proxy_host) return '<span class="dot"></span>Direct (server IP)';
        var tone = s.proxy_status === 'dead' ? 'bad' : s.proxy_status === 'slow' ? 'warn' : 'ok';
        return '<span class="dot ' + tone + '"></span>via ' + esc(proxyLabel({ username: s.proxy_username, host: s.proxy_host, port: s.proxy_port })) +
            (s.proxy_latency_ms != null ? ' · ' + esc(latency(s.proxy_latency_ms)) : '') + (s.pool_name ? ' · ' + esc(s.pool_owner ? 'My proxies' : s.pool_name) : '');
    }

    /** Picker: every proxy the user may use, grouped by pool, current one selected. */
    async function chooseProxy(sessionId) {
        var data;
        try { data = await P.api('GET', '/api/portal/sessions/' + encodeURIComponent(sessionId) + '/proxies'); } catch (err) { return P.toast(err.message); }
        var wrap = document.createElement('div');
        wrap.className = 'dialog-backdrop';
        var groups = data.pools.map(function (pool) {
            return '<fieldset class="proxy-group"><legend>' + esc(pool.name) + (pool.country ? ' · ' + esc(pool.country) : '') + '</legend>' +
                pool.proxies.map(function (x) {
                    var tone = !x.usable ? 'bad' : x.status === 'slow' ? 'warn' : x.status === 'healthy' ? 'ok' : '';
                    var state = !x.enabled ? 'Disabled' : x.status === 'dead' ? 'Offline' : x.status === 'slow' ? 'Slow' : x.status === 'healthy' ? 'Online' : 'Not checked';
                    return '<label class="proxy-option' + (x.usable ? '' : ' disabled') + '"><input type="radio" name="proxy" value="' + esc(x.id) + '"' +
                        (x.current ? ' checked' : '') + (x.usable ? '' : ' disabled') + '>' +
                        '<span class="grow"><span class="mono">' + esc(x.label) + '</span>' + (x.current ? ' <span class="badge accent plain">Current</span>' : '') +
                        '<span class="meta"><span class="dot ' + tone + '"></span>' + state + (x.latency_ms != null ? ' · ' + esc(latency(x.latency_ms)) : '') +
                        (x.active_sessions ? ' · ' + x.active_sessions + ' session' + (x.active_sessions > 1 ? 's' : '') : '') + '</span></span></label>';
                }).join('') + '</fieldset>';
        }).join('');
        wrap.innerHTML = '<form class="dialog proxy-dialog" role="dialog" aria-modal="true" aria-labelledby="px-title" novalidate>' +
            '<h2 id="px-title">Change proxy</h2>' +
            '<p class="muted small">The next page you open in this session goes out through the selected proxy. The site\'s cookies stay; sites that tie a login to the IP address may ask you to sign in again.</p>' +
            '<div class="proxy-list">' + (groups || '<p class="muted">No proxies available.</p>') + '</div>' +
            '<div class="alert error hidden" role="alert" id="px-error"></div>' +
            '<div class="row end"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" id="px-go">Use this proxy</button></div></form>';
        document.body.appendChild(wrap);
        var close = function () { wrap.remove(); document.removeEventListener('keydown', onKey); };
        var onKey = function (e) { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
        P.$('[data-cancel]', wrap).addEventListener('click', close);
        var first = P.$('input:checked', wrap) || P.$('input:not([disabled])', wrap);
        if (first) first.focus();
        P.$('form', wrap).addEventListener('submit', async function (e) {
            e.preventDefault();
            var picked = P.$('input[name=proxy]:checked', wrap);
            if (!picked) return P.showError(P.$('#px-error', wrap), 'Pick a proxy');
            var done = P.busy(P.$('#px-go', wrap), 'Switching');
            try {
                var r = await P.api('POST', '/api/portal/sessions/' + encodeURIComponent(sessionId) + '/proxy', { proxyId: picked.value });
                close();
                P.toast(r.changed ? 'Now using ' + r.proxy + '. Reload the site to continue through it.' : 'Already using that proxy', 5000);
                loadSessions();
            } catch (err) {
                done();
                P.showError(P.$('#px-error', wrap), err.message);
            }
        });
    }

    async function loadSessions() {
        var list = await P.api('GET', '/api/portal/sessions');
        var ul = P.$('#sessions');
        P.$('#session-count').textContent = list.length ? '(' + list.length + ')' : '';
        if (!list.length) {
            ul.innerHTML = '<li class="empty"><div><strong>No active sessions</strong>Search or open a website on the <a href=\"/\">start page</a> to start one.</div></li>';
            return;
        }
        ul.innerHTML = list.map(function (s) {
            var host = hostOf(s.start_url);
            return '<li><span class="initial" aria-hidden="true">' + esc(host.replace(/^www\./, '').charAt(0)) + '</span>' +
                '<div class="grow"><div class="title">' + esc(host) + '</div><div class="meta">Started ' + esc(P.timeAgo(s.created_at)) +
                ' · used ' + esc(P.timeAgo(s.last_seen_at)) + ' · ' + esc(P.formatBytes(s.bytes)) + '</div>' +
                '<div class="meta via-line" title="Upstream proxy this session goes out through">' + proxyBadge(s) + '</div></div>' +
                '<div class="actions"><button type="button" class="small primary" data-resume="' + esc(s.id) + '" aria-label="Resume ' + esc(host) + '">Resume</button>' +
                '<button type="button" class="small" data-proxy="' + esc(s.id) + '" aria-label="Change the proxy of ' + esc(host) + '">Proxy</button>' +
                '<button type="button" class="small" data-end="' + esc(s.id) + '" aria-label="End session on ' + esc(host) + '">End</button></div></li>';
        }).join('');
        P.$all('[data-proxy]', ul).forEach(function (btn) {
            btn.addEventListener('click', function () { chooseProxy(btn.getAttribute('data-proxy')); });
        });
        P.$all('[data-resume]', ul).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ sessionId: btn.getAttribute('data-resume') }, btn); });
        });
        P.$all('[data-end]', ul).forEach(function (btn) {
            btn.addEventListener('click', async function () {
                var ok = await P.confirm('The site will forget your login for this session.', { title: 'End this session?', confirmLabel: 'End session', danger: true });
                if (!ok) return;
                var done = P.busy(btn, 'Ending');
                try {
                    await P.api('DELETE', '/api/portal/sessions/' + encodeURIComponent(btn.getAttribute('data-end')));
                    P.toast('Session ended');
                    loadSessions();
                } catch (err) {
                    P.toast(err.message);
                    done();
                }
            });
        });
    }

    P.$('#refresh').addEventListener('click', loadSessions);
    P.shell('sessions').then(function (me) { if (me.user) return loadSessions(); }).catch(function (err) { P.showError(goError, err.message); });
})();
