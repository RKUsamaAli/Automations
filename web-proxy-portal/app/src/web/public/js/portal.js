/* Browse page: address bar + pool picker, sessions, quick access. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var goError = P.$('#go-error');
    var poolsById = {};
    var siteList = [];

    function selectedPool() {
        var v = P.$('#pool').value;
        return v || null;
    }
    function hostOf(url) {
        try { return new URL(url).hostname; } catch (_) { return url || '-'; }
    }

    /** Asks the portal for a one-time hand-off link and opens the proxy. */
    async function browse(body, button) {
        var done = P.busy(button, 'Opening');
        P.showError(goError, '');
        try {
            if (!body.sessionId) body.poolId = selectedPool();
            var res = await P.api('POST', '/api/portal/browse', body);
            // Same tab on purpose: iOS Safari blocks pop-ups opened after an await.
            location.href = res.redirect;
        } catch (err) {
            P.showError(goError, err.message);
            done();
        }
    }

    P.$('#go-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var url = P.$('#url').value.trim();
        if (!url) {
            P.showError(goError, 'Type a web address (example.com) or something to search for');
            P.$('#url').setAttribute('aria-invalid', 'true');
            return P.$('#url').focus();
        }
        P.$('#url').removeAttribute('aria-invalid');
        browse({ url: url }, P.$('#go'));
    });
    P.$('#refresh').addEventListener('click', loadSessions);

    // Address bar: words -> search results (through the proxy), an address -> that site.
    // Suggestions while typing: the main action first ("Search Google for ..." /
    // "Go to ..."), then the admin's sites, pages opened before and the search
    // engine's own suggestions. Picking any of them opens it straight away.
    var LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\/|^[^\s/?#]+\.[a-z][a-z0-9-]+(?::\d+)?(?:[/?#]\S*)?$|^localhost(?::\d+)?/i;
    var engineName = 'Google';
    P.suggest(P.$('#url'), {
        source: function (q) {
            q = q.trim();
            var sites = P.filterOptions(siteList.map(function (s) { return { value: s.startUrl, label: s.name, hint: s.host, siteId: s.id }; }), q, 4);
            var isUrl = LOOKS_LIKE_URL.test(q);
            var main = q ? [{ value: q, label: isUrl ? q : q, hint: isUrl ? 'Go to this address' : 'Search ' + engineName, action: true }] : [];
            return Promise.all([
                P.api('GET', '/api/portal/recent?q=' + encodeURIComponent(q)).catch(function () { return []; }),
                q.length >= 2 && !isUrl ? P.api('GET', '/api/portal/search-suggest?q=' + encodeURIComponent(q)).catch(function () { return { suggestions: [] }; }) : Promise.resolve({ suggestions: [] })
            ]).then(function (r) {
                var known = {};
                sites.forEach(function (s) { known[s.hint] = true; });
                if (r[1].engine) { engineName = r[1].engine; if (main[0] && !isUrl) main[0].hint = 'Search ' + engineName; }
                var terms = (r[1].suggestions || []).filter(function (t) { return t.toLowerCase() !== q.toLowerCase(); }).slice(0, 5)
                    .map(function (t) { return { value: t, label: t, hint: 'Search', search: true }; });
                return [
                    { items: main },
                    { label: 'Your sites', items: sites },
                    { label: 'Recently opened', items: r[0].filter(function (x) { return !known[x.label] && !known['www.' + x.label]; }).slice(0, 4) },
                    { label: 'Search suggestions', items: terms }
                ];
            });
        },
        onPick: function (item) {
            P.$('#url').value = item.value;
            browse(item.siteId ? { siteId: item.siteId } : { url: item.value }, P.$('#go'));
        }
    });

    async function loadPools() {
        var pools = await P.api('GET', '/api/portal/pools');
        var select = P.$('#pool');
        pools.forEach(function (p) { poolsById[p.id] = p; });
        select.innerHTML = '<option value="">Automatic proxy</option>' + pools.map(function (p) {
            return '<option value="' + p.id + '">' + esc(p.name) + (p.country ? ' · ' + esc(p.country) : '') + '</option>';
        }).join('');
        P.$('#via').classList.toggle('hidden', !pools.length);
        var saved = null;
        try { saved = localStorage.getItem('portal.pool'); } catch (_) { /* private mode */ }
        if (saved && poolsById[saved]) select.value = saved;
        var update = function () {
            var p = poolsById[select.value];
            P.$('#pool-health').textContent = p ? p.usable + ' of ' + p.total + ' online' : '';
            try { localStorage.setItem('portal.pool', select.value); } catch (_) { /* ignore */ }
        };
        select.addEventListener('change', update);
        update();
    }

    async function loadSites() {
        var sites = await P.api('GET', '/api/portal/sites');
        siteList = sites;
        var box = P.$('#sites');
        P.$('#sites-card').classList.toggle('hidden', !sites.length);
        var chevron = '<svg class="icon chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
        box.innerHTML = sites.map(function (s) {
            return '<li class="link-row"><button type="button" class="rowlink" data-site="' + s.id + '">' +
                '<span class="initial" aria-hidden="true">' + esc(s.name.charAt(0)) + '</span>' +
                '<span class="grow"><span class="title" data-block>' + esc(s.name) + '</span><span class="meta" data-block>' + esc(s.host) + '</span></span>' +
                chevron + '</button></li>';
        }).join('');
        P.$all('[data-site]', box).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ siteId: btn.getAttribute('data-site') }, btn); });
        });
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
            ul.innerHTML = '<li class="empty"><div><strong>No active sessions</strong>Open a website above to start one.</div></li>';
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

    P.shell('browse').then(function (me) {
        if (!me.user) return;
        if (me.portal.notice) {
            P.$('#notice').textContent = me.portal.notice;
            P.$('#notice').classList.remove('hidden');
        }
        return Promise.all([loadPools(), loadSites(), loadSessions()]);
    }).catch(function (err) { P.showError(goError, err.message); });
})();
