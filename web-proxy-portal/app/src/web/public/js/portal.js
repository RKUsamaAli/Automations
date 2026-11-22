/* Browse page: address bar, pool picker, site tiles, active sessions. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var goError = P.$('#go-error');
    var poolsById = {};

    function selectedPool() {
        var v = P.$('#pool').value;
        return v ? Number(v) : null;
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
            P.showError(goError, 'Type a website address first, for example example.com');
            return P.$('#url').focus();
        }
        browse({ url: url }, P.$('#go'));
    });
    P.$('#refresh').addEventListener('click', loadSessions);

    async function loadPools() {
        var pools = await P.api('GET', '/api/portal/pools');
        var select = P.$('#pool');
        pools.forEach(function (p) { poolsById[p.id] = p; });
        select.innerHTML = '<option value="">Automatic (recommended)</option>' + pools.map(function (p) {
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
        var box = P.$('#sites');
        P.$('#sites-card').classList.toggle('hidden', !sites.length);
        box.innerHTML = sites.map(function (s) {
            return '<button type="button" class="tile" data-site="' + s.id + '"><span class="tile-icon" data-color="' + esc(s.name) + '">' + esc(s.name.charAt(0)) + '</span>' +
                '<span class="tile-text"><strong>' + esc(s.name) + '</strong><span>' + esc(s.host) + '</span></span></button>';
        }).join('');
        P.$all('[data-color]', box).forEach(function (el) { el.style.background = P.colorFor(el.getAttribute('data-color')); });
        P.$all('[data-site]', box).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ siteId: Number(btn.getAttribute('data-site')) }, btn); });
        });
    }

    async function loadSessions() {
        var list = await P.api('GET', '/api/portal/sessions');
        var ul = P.$('#sessions');
        if (!list.length) {
            ul.innerHTML = '<li class="empty">' + P.icon('browse', '') + '<div><strong>No active sessions</strong>Open a website above to start one.</div></li>';
            return;
        }
        ul.innerHTML = list.map(function (s) {
            var host = '';
            try { host = new URL(s.start_url).hostname; } catch (_) { host = s.start_url || '-'; }
            return '<li><span class="site-favicon">' + esc(host.replace(/^www\./, '').charAt(0)) + '</span>' +
                '<div class="grow"><strong>' + esc(host) + '</strong><div class="meta">Started ' + esc(P.timeAgo(s.created_at)) +
                ' · used ' + esc(P.timeAgo(s.last_seen_at)) + ' · ' + esc(P.formatBytes(s.bytes)) +
                (s.pool_name ? ' · ' + esc(s.pool_name) : '') + '</div></div>' +
                '<div class="actions"><button type="button" class="small primary" data-resume="' + esc(s.id) + '">Resume</button>' +
                '<button type="button" class="small danger" data-end="' + esc(s.id) + '">End</button></div></li>';
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
        var hour = new Date().getHours();
        P.$('#hero-title').textContent = (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + ', ' + me.user.username;
        return Promise.all([loadPools(), loadSites(), loadSessions()]);
    }).catch(function (err) { P.showError(goError, err.message); });
})();
