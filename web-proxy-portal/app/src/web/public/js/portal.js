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
            P.showError(goError, 'Enter a website address, for example example.com');
            P.$('#url').setAttribute('aria-invalid', 'true');
            return P.$('#url').focus();
        }
        P.$('#url').removeAttribute('aria-invalid');
        browse({ url: url }, P.$('#go'));
    });
    P.$('#refresh').addEventListener('click', loadSessions);

    // Address bar suggestions: the admin's site tiles + pages this user opened before.
    // Picking one opens it straight away.
    P.suggest(P.$('#url'), {
        source: function (q) {
            var sites = P.filterOptions(siteList.map(function (s) { return { value: s.startUrl, label: s.name, hint: s.host, siteId: s.id }; }), q, 5);
            return P.api('GET', '/api/portal/recent?q=' + encodeURIComponent(q)).then(function (recent) {
                var known = {};
                sites.forEach(function (s) { known[s.hint] = true; });
                return [{ label: 'Your sites', items: sites }, { label: 'Recently opened', items: recent.filter(function (r) { return !known[r.label] && !known['www.' + r.label]; }) }];
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
                ' · used ' + esc(P.timeAgo(s.last_seen_at)) + ' · ' + esc(P.formatBytes(s.bytes)) + (s.pool_name ? ' · ' + esc(s.pool_name) : '') + '</div></div>' +
                '<div class="actions"><button type="button" class="small primary" data-resume="' + esc(s.id) + '" aria-label="Resume ' + esc(host) + '">Resume</button>' +
                '<button type="button" class="small" data-end="' + esc(s.id) + '" aria-label="End session on ' + esc(host) + '">End</button></div></li>';
        }).join('');
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
