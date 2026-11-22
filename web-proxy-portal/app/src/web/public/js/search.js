/* Search results page: Google results fetched by the server's headless browser
   through the chosen connection (?via=direct | pool id | auto). A result opens
   through the same connection in a new browsing session. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var params = new URLSearchParams(location.search);
    var q = params.get('q') || '';
    var via = params.get('via') || 'direct';
    var LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\/|^[^\s/?#]+\.[a-z][a-z0-9-]+(?::\d+)?(?:[/?#]\S*)?$|^localhost(?::\d+)?/i;

    P.$('#url').value = q;
    document.title = (q ? q + ' - ' : '') + 'Search';

    async function open(url, button) {
        var done = P.busy(button, 'Opening');
        try {
            var res = await P.api('POST', '/api/portal/browse', { url: url, poolId: via });
            location.href = res.redirect;
        } catch (err) {
            done();
            P.showError(P.$('#error'), err.message);
        }
    }

    async function run() {
        if (!q) return;
        var box = P.$('#results');
        box.innerHTML = '<div class="result-skeleton" aria-hidden="true">' + new Array(5).join('<div class="result"><span></span><span></span><span></span></div>') + '</div>';
        P.$('#meta').textContent = 'Searching…';
        var started = Date.now();
        try {
            var r = await P.api('GET', '/api/portal/search?q=' + encodeURIComponent(q) + '&via=' + encodeURIComponent(via));
            var secs = ((Date.now() - started) / 1000).toFixed(1);
            P.$('#meta').innerHTML = esc(r.results.length + ' results from ' + (r.engine === 'google' ? 'Google' : 'DuckDuckGo') + ' · ' + secs + ' s' + (r.cached ? ' (cached)' : '')) +
                ' · <span class="dot ' + (via === 'direct' ? '' : 'ok') + '"></span>' + esc(r.via);
            if (r.note) { P.$('#note').textContent = r.note; P.$('#note').classList.remove('hidden'); }
            if (!r.results.length) {
                box.innerHTML = '<div class="empty"><strong>No results</strong>Try other words.</div>';
                return;
            }
            box.innerHTML = r.results.map(function (x, i) {
                return '<div class="result"><div class="r-site">' + esc(x.displayUrl) + '</div>' +
                    '<button type="button" class="r-title" data-open="' + i + '">' + esc(x.title) + '</button>' +
                    (x.snippet ? '<div class="r-snippet">' + esc(x.snippet) + '</div>' : '') + '</div>';
            }).join('');
            P.$all('[data-open]', box).forEach(function (b) {
                b.addEventListener('click', function () { open(r.results[Number(b.getAttribute('data-open'))].url, b); });
            });
        } catch (err) {
            box.innerHTML = '';
            P.$('#meta').textContent = '';
            P.showError(P.$('#error'), err.message);
        }
    }

    P.$('#go-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var v = P.$('#url').value.trim();
        if (!v) return P.$('#url').focus();
        if (LOOKS_LIKE_URL.test(v)) return open(v, P.$('#go'));
        location.href = '/search?q=' + encodeURIComponent(v) + '&via=' + encodeURIComponent(via);
    });

    P.shell('browse').then(function (me) { if (me.user) run(); });
})();
