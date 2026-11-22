/* Landing page: URL bar, site tiles, active sessions. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var goError = P.$('#go-error');

    /** Asks the server for a hand-off link and navigates to the proxy. */
    async function browse(body, button) {
        if (button) button.disabled = true;
        P.showError(goError, '');
        try {
            var res = await P.api('POST', '/api/portal/browse', body);
            // Same tab: iOS Safari blocks pop-ups opened after an await.
            location.href = res.redirect;
        } catch (err) {
            P.showError(goError, err.message);
            window.scrollTo(0, 0);
            if (button) button.disabled = false;
        }
    }

    P.$('#go-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var url = P.$('#url').value.trim();
        if (!url) return P.$('#url').focus();
        browse({ url: url }, P.$('#go'));
    });

    P.$('#logout').addEventListener('click', P.logout);
    P.$('#refresh').addEventListener('click', loadSessions);

    async function loadMe() {
        var me = await P.api('GET', '/api/auth/me');
        if (!me.user) return (location.href = '/login');
        P.$('#brand').textContent = me.portal.title || 'Portal';
        document.title = me.portal.title || 'Portal';
        if (me.user.role === 'admin') P.$('#admin-link').classList.remove('hidden');
        if (me.portal.notice) {
            P.$('#notice').textContent = me.portal.notice;
            P.$('#notice').classList.remove('hidden');
        }
    }

    async function loadSites() {
        var sites = await P.api('GET', '/api/portal/sites');
        var box = P.$('#sites');
        P.$('#sites-card').classList.toggle('hidden', !sites.length);
        box.innerHTML = sites.map(function (s) {
            return '<button type="button" class="tile" data-site="' + s.id + '"><strong>' + esc(s.name) + '</strong><span>' + esc(s.host) + '</span></button>';
        }).join('');
        P.$all('[data-site]', box).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ siteId: Number(btn.getAttribute('data-site')) }, btn); });
        });
    }

    async function loadSessions() {
        var list = await P.api('GET', '/api/portal/sessions');
        var ul = P.$('#sessions');
        if (!list.length) {
            ul.innerHTML = '<li class="muted">No active sessions.</li>';
            return;
        }
        ul.innerHTML = list.map(function (s) {
            var host = '';
            try { host = new URL(s.start_url).hostname; } catch (_) { host = s.start_url || '-'; }
            return '<li>' +
                '<div class="grow"><strong>' + esc(host) + '</strong><div class="muted small">Started ' + esc(P.timeAgo(s.created_at)) +
                ' &middot; last used ' + esc(P.timeAgo(s.last_seen_at)) + ' &middot; ' + esc(P.formatBytes(s.bytes)) +
                (s.pool_name ? ' &middot; ' + esc(s.pool_name) : '') + '</div></div>' +
                '<button type="button" class="small primary" data-resume="' + esc(s.id) + '">Resume</button>' +
                '<button type="button" class="small danger" data-end="' + esc(s.id) + '">End</button>' +
                '</li>';
        }).join('');
        P.$all('[data-resume]', ul).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ sessionId: btn.getAttribute('data-resume') }, btn); });
        });
        P.$all('[data-end]', ul).forEach(function (btn) {
            btn.addEventListener('click', async function () {
                if (!confirm('End this session? The site will forget your login.')) return;
                btn.disabled = true;
                try {
                    await P.api('DELETE', '/api/portal/sessions/' + encodeURIComponent(btn.getAttribute('data-end')));
                    P.toast('Session ended');
                    loadSessions();
                } catch (err) {
                    P.toast(err.message);
                    btn.disabled = false;
                }
            });
        });
    }

    loadMe().then(function () { return Promise.all([loadSites(), loadSessions()]); }).catch(function (err) { P.showError(goError, err.message); });
})();
