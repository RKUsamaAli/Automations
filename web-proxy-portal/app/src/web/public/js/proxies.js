/* "My proxies": users add, check, disable and remove their own upstream proxies. */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var STATUS = {
        healthy: ['ok', 'Online'],
        slow: ['warn', 'Slow'],
        dead: ['bad', 'Offline'],
        unknown: ['', 'Checking…']
    };

    function statusBadge(x) {
        if (!x.enabled) return '<span class="badge">Disabled</span>';
        // First failures (before it is declared offline) show as "Not responding".
        var s = x.status === 'unknown' && x.last_error ? ['warn', 'Not responding'] : STATUS[x.status] || STATUS.unknown;
        return '<span class="badge ' + s[0] + '">' + s[1] + '</span>';
    }

    async function load() {
        var data = await P.api('GET', '/api/portal/proxies');
        var count = data.proxies.length;
        P.$('#usage').textContent = '(' + count + ')';
        P.$('#usage-hint').textContent = count + ' of ' + data.limit + ' used';
        P.$('#usage-bar').style.width = Math.min(100, Math.round((count / Math.max(1, data.limit)) * 100)) + '%';
        var ul = P.$('#list');
        if (!count) {
            ul.innerHTML = '<li class="empty"><div><strong>No proxies yet</strong>Paste your list in “Add proxies” to get started.</div></li>';
            return;
        }
        ul.innerHTML = data.proxies.map(function (x) {
            var label = x.protocol + '://' + (x.username ? x.username + ':•••@' : '') + x.host + ':' + x.port;
            var meta = [];
            if (x.latency_ms != null && x.enabled) meta.push(x.latency_ms + ' ms');
            meta.push('checked ' + P.timeAgo(x.last_checked_at));
            if (x.active_sessions) meta.push(x.active_sessions + ' active session' + (x.active_sessions > 1 ? 's' : ''));
            return '<li><div class="grow"><div class="title mono">' + esc(label) + '</div><div class="meta">' + esc(meta.join(' · ')) +
                (x.last_error && x.status !== 'healthy' ? ' · ' + esc(x.last_error) : '') + '</div></div>' +
                statusBadge(x) +
                '<div class="actions"><button type="button" class="small" data-toggle="' + x.id + '" data-enabled="' + x.enabled + '">' + (x.enabled ? 'Disable' : 'Enable') + '</button>' +
                '<button type="button" class="small danger" data-remove="' + x.id + '" aria-label="Remove ' + esc(label) + '">Remove</button></div></li>';
        }).join('');
        P.$all('[data-toggle]', ul).forEach(function (btn) {
            btn.addEventListener('click', async function () {
                await P.api('PATCH', '/api/portal/proxies/' + btn.getAttribute('data-toggle'), { enabled: btn.getAttribute('data-enabled') !== '1' });
                load();
            });
        });
        P.$all('[data-remove]', ul).forEach(function (btn) {
            btn.addEventListener('click', async function () {
                if (!(await P.confirm('Sessions using this proxy will switch to another one or stop.', { title: 'Remove proxy?', confirmLabel: 'Remove', danger: true }))) return;
                await P.api('DELETE', '/api/portal/proxies/' + btn.getAttribute('data-remove'));
                P.toast('Proxy removed');
                load();
            });
        });
    }

    P.$('#add-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        var result = P.$('#add-result');
        var text = P.$('#text').value.trim();
        if (!text) {
            result.className = 'alert error';
            result.textContent = 'Paste at least one proxy.';
            return;
        }
        var done = P.busy(P.$('#add'), 'Adding');
        try {
            var r = await P.api('POST', '/api/portal/proxies', { text: text, defaultProtocol: P.$('#protocol').value });
            result.className = 'alert ' + (r.errors.length ? (r.added ? 'warn' : 'error') : 'success');
            result.innerHTML = '<strong>' + r.added + ' added</strong>' + (r.skipped ? ', ' + r.skipped + ' already in your list' : '') + '.' +
                (r.added ? ' Checking them now…' : '') +
                (r.errors.length ? '<br>' + r.errors.map(esc).join('<br>') : '');
            if (r.added) P.$('#text').value = '';
            load();
            if (r.added) setTimeout(load, 4000);
        } catch (err) {
            result.className = 'alert error';
            result.textContent = err.message;
        }
        done();
    });

    P.$('#check').addEventListener('click', async function () {
        var done = P.busy(P.$('#check'), 'Checking');
        try {
            var r = await P.api('POST', '/api/portal/proxies/check');
            P.toast(r.checked ? r.checked + ' checked: ' + (r.healthy || 0) + ' online' + (r.dead ? ', ' + r.dead + ' offline' : '') : 'Nothing to check yet');
        } catch (err) { P.toast(err.message); }
        done();
        load();
    });

    P.shell('proxies').then(function (me) {
        if (!me.user) return;
        if (!me.portal.userProxies) {
            P.$('#disabled').classList.remove('hidden');
            P.$('#add-card').classList.add('hidden');
            return;
        }
        return load();
    }).catch(function (err) { P.toast(err.message); });
})();
