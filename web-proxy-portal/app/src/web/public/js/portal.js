/* Start page: only the search box in the middle, recent searches under it.
   Signed in: the proxy chip in the top bar (no proxy by default / a proxy pool).
   Signed out: searching asks to sign in first. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var goError = P.$('#go-error');
    var poolsById = {};
    var siteList = [];
    var serverSearch = true; // Google results via the server's browser (portal.searchServer)
    var signedIn = false;
    var liveMode = false; // portal.browseMode === 'live': open everything in the live browser (/live)

    /** 'direct' (proxy switch off), a pool id, or 'auto' (automatic proxy). */
    function selectedPool() {
        if (!P.$('#proxy-on') || !P.$('#proxy-on').checked) return 'direct';
        return P.$('#pool').value || 'auto';
    }
    function goSearch(q) {
        if (liveMode) { location.href = '/live?q=' + encodeURIComponent(q); return; }
        location.href = '/search?q=' + encodeURIComponent(q) + '&via=' + encodeURIComponent(selectedPool());
    }

    /** Asks the portal for a one-time hand-off link and opens the proxy. */
    async function browse(body, button) {
        if (!signedIn) { location.href = '/login?next=/'; return; }
        if (liveMode) {
            var site = body.siteId && siteList.filter(function (x) { return x.id === body.siteId; })[0];
            var url = site ? site.startUrl : body.url;
            location.href = '/live?' + (url && LOOKS_LIKE_URL.test(url) ? 'url=' : 'q=') + encodeURIComponent(url || '');
            return;
        }
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
        // signed out: sign in first, then come back here and run it
        if (!signedIn) { location.href = '/login?next=' + encodeURIComponent('/?q=' + url); return; }
        // words -> results page (Google via the server's browser); an address -> that site
        if (serverSearch && !LOOKS_LIKE_URL.test(url)) return goSearch(url);
        browse({ url: url }, P.$('#go'));
    });

    // Address bar: words -> search results (through the proxy), an address -> that site.
    // Suggestions while typing: the main action first ("Search Google for ..." /
    // "Go to ..."), then the admin's sites, pages opened before and the search
    // engine's own suggestions. Picking any of them opens it straight away.
    var LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\/|^[^\s/?#]+\.[a-z][a-z0-9-]+(?::\d+)?(?:[/?#]\S*)?$|^localhost(?::\d+)?/i;
    var engineName = 'Google';
    P.suggest(P.$('#url'), {
        source: function (q) {
            q = q.trim();
            if (!signedIn) {
                var u = LOOKS_LIKE_URL.test(q);
                return Promise.resolve(q ? [{ items: [{ value: q, label: q, hint: u ? 'Go to this address' : 'Search ' + engineName, action: true }] }] : []);
            }
            var sites = P.filterOptions(siteList.map(function (s) { return { value: s.startUrl, label: s.name, hint: s.host, siteId: s.id }; }), q, 4);
            var isUrl = LOOKS_LIKE_URL.test(q);
            var main = q ? [{ value: q, label: isUrl ? q : q, hint: isUrl ? 'Go to this address' : 'Search ' + engineName, action: true }] : [];
            return Promise.all([
                P.api('GET', '/api/portal/recent?q=' + encodeURIComponent(q)).catch(function () { return []; }),
                q.length >= 2 && !isUrl ? P.api('GET', '/api/portal/search-suggest?q=' + encodeURIComponent(q)).catch(function () { return { suggestions: [] }; }) : Promise.resolve({ suggestions: [] }),
                !isUrl ? P.api('GET', '/api/portal/searches?limit=6&q=' + encodeURIComponent(q)).catch(function () { return []; }) : Promise.resolve([])
            ]).then(function (r) {
                var known = {};
                sites.forEach(function (s) { known[s.hint] = true; });
                if (r[1].engine) { engineName = r[1].engine; if (main[0] && !isUrl) main[0].hint = 'Search ' + engineName; }
                var terms = (r[1].suggestions || []).filter(function (t) { return t.toLowerCase() !== q.toLowerCase(); }).slice(0, 5)
                    .map(function (t) { return { value: t, label: t, hint: 'Search', search: true }; });
                var past = (r[2] || []).filter(function (x) { return x.query.toLowerCase() !== q.toLowerCase(); }).slice(0, 4)
                    .map(function (x) { return { value: x.query, label: x.query, hint: 'Searched before', search: true }; });
                return [
                    { items: main },
                    { label: 'Recent searches', items: past },
                    { label: 'Your sites', items: sites },
                    { label: 'Recently opened', items: r[0].filter(function (x) { return !known[x.label] && !known['www.' + x.label]; }).slice(0, 4) },
                    { label: 'Search suggestions', items: terms }
                ];
            });
        },
        onPick: function (item) {
            P.$('#url').value = item.value;
            if (serverSearch && !item.siteId && !LOOKS_LIKE_URL.test(item.value)) return goSearch(item.value);
            browse(item.siteId ? { siteId: item.siteId } : { url: item.value }, P.$('#go'));
        }
    });

    /**
     * Connection: the "Use a proxy" switch (off = the server's own connection,
     * the default) and, when on, which pool. Remembered per browser.
     */
    async function loadPools(portal) {
        var pools = await P.api('GET', '/api/portal/pools');
        var select = P.$('#pool');
        var sw = P.$('#proxy-on');
        pools.forEach(function (p) { poolsById[p.id] = p; });
        select.innerHTML = '<option value="">Automatic (best available)</option>' + pools.map(function (p) {
            return '<option value="' + p.id + '">' + esc(p.name) + (p.country ? ' · ' + esc(p.country) : '') + ' (' + p.usable + '/' + p.total + ' online)</option>';
        }).join('');
        var saved = {};
        try { saved = JSON.parse(localStorage.getItem('portal.connection') || '{}') || {}; } catch (_) { /* private mode */ }
        if (saved.pool && poolsById[saved.pool]) select.value = saved.pool;
        sw.checked = pools.length > 0 && (saved.proxy === true || !portal.allowDirect);
        sw.disabled = !pools.length || !portal.allowDirect;
        P.$('#proxy-hint').textContent = !pools.length
            ? 'No proxies yet. Add your own under My proxies.'
            : !portal.allowDirect ? 'Your administrator requires a proxy.' : "Off: websites see the server's own connection.";
        var update = function () {
            var on = sw.checked;
            P.$('#via').classList.toggle('hidden', !on);
            var p = poolsById[select.value];
            P.$('#pool-health').textContent = on && p ? p.usable + ' of ' + p.total + ' online' : '';
            P.$('#conn-line').textContent = on ? (p ? p.name + (p.country ? ' · ' + p.country : '') : 'Automatic proxy') : 'No proxy';
            P.$('#conn-dot').className = 'dot' + (on ? (p && !p.usable ? ' bad' : ' ok') : '');
            P.$('#conn-chip').title = on ? 'New sessions go out through a proxy' : "No proxy: websites see the server's own connection";
            try { localStorage.setItem('portal.connection', JSON.stringify({ proxy: on, pool: select.value })); } catch (_) { /* ignore */ }
        };
        sw.addEventListener('change', update);
        select.addEventListener('change', update);
        update();
    }

    async function loadSites() {
        var sites = await P.api('GET', '/api/portal/sites');
        siteList = sites;
        var box = P.$('#sites');
        P.$('#sites-card').classList.toggle('hidden', !sites.length);
        box.innerHTML = sites.map(function (s) {
            return '<li><button type="button" data-site="' + s.id + '" title="' + esc(s.host) + '">' +
                '<span class="initial" aria-hidden="true">' + esc(s.name.charAt(0)) + '</span><span class="tile-name">' + esc(s.name) + '</span></button></li>';
        }).join('');
        P.$all('[data-site]', box).forEach(function (btn) {
            btn.addEventListener('click', function () { browse({ siteId: btn.getAttribute('data-site') }, btn); });
        });
    }

    /** Recent searches under the search box: tap to search again, x to forget one. */
    async function loadRecent() {
        var list = await P.api('GET', '/api/portal/searches?limit=8');
        var box = P.$('#recent');
        box.classList.toggle('hidden', !list.length);
        P.$('#recent-list').innerHTML = list.map(function (x) {
            return '<li><button type="button" class="recent-q" data-q="' + esc(x.query) + '">' + P.icon('clock', 'icon') + '<span>' + esc(x.query) + '</span></button>' +
                '<button type="button" class="recent-x" data-del="' + esc(x.id) + '" aria-label="Remove ' + esc(x.query) + ' from recent searches">&times;</button></li>';
        }).join('');
        P.$all('[data-q]', box).forEach(function (b) {
            b.addEventListener('click', function () { P.$('#url').value = b.getAttribute('data-q'); goSearch(b.getAttribute('data-q')); });
        });
        P.$all('[data-del]', box).forEach(function (b) {
            b.addEventListener('click', async function () {
                await P.api('DELETE', '/api/portal/searches/' + encodeURIComponent(b.getAttribute('data-del'))).catch(function () {});
                loadRecent();
            });
        });
    }
    P.$('#recent-clear').addEventListener('click', async function () {
        var ok = await P.confirm('Your recent searches will be removed from this list.', { title: 'Clear recent searches?', confirmLabel: 'Clear' });
        if (!ok) return;
        await P.api('DELETE', '/api/portal/searches').catch(function (err) { P.toast(err.message); });
        loadRecent();
    });

    // back from signing in with a pending search/address (/?q=...): run it
    function runPending() {
        var pending = new URLSearchParams(location.search).get('q');
        if (pending) {
            history.replaceState(null, '', '/');
            P.$('#url').value = pending;
            P.$('#go-form').requestSubmit();
        }
    }

    P.shell('browse', { public: true }).then(function (me) {
        if (me.portal.title) P.$('#start-title').textContent = me.portal.title;
        serverSearch = me.portal.searchServer !== false;
        if (!me.user) return; // signed out: search box only; searching asks to sign in
        signedIn = true;
        liveMode = me.portal.browseMode === 'live';
        if (me.portal.notice) {
            P.$('#notice').textContent = me.portal.notice;
            P.$('#notice').classList.remove('hidden');
        }
        // live browser: no proxies yet - search box, recent searches and sites only
        if (liveMode) return Promise.all([loadSites(), loadRecent()]).then(runPending);
        // the proxy chip goes into the top bar, right side
        var slot = P.$('.topbar .page-actions');
        slot.appendChild(P.$('#conn-template').content.cloneNode(true));
        P.popover(P.$('#conn-chip'), P.$('#conn-panel'));
        return Promise.all([loadPools(me.portal), loadSites(), loadRecent()]).then(runPending);
    }).catch(function (err) { P.showError(goError, err.message); });
})();
