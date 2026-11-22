/* =============================================================================
   Admin panel. One render function per section ("view") draws into #view.
   Forms and details open in a side panel (#modal), so the list stays visible.

   Sections: Dashboard, Users, Proxy pools, Sessions, Sites, Scripts,
             Requests, Errors, Server, Activity log, Settings
   No inline styles anywhere (the Content-Security-Policy forbids them).
   ============================================================================= */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var view = P.$('#view');
    var state = { pools: [], poolTypes: [] };

    // ============================================================== helpers ==
    function on(selector, event, handler, root) {
        P.$all(selector, root || view).forEach(function (el) { el.addEventListener(event, function (e) { handler(el, e); }); });
    }
    async function confirmed(message, fn, opts) {
        if (!(await P.confirm(message, opts || { confirmLabel: 'Continue', danger: true }))) return;
        try { await fn(); } catch (err) { P.toast(err.message); }
    }
    function setCount(id, n) {
        var el = P.$(id);
        el.textContent = n;
        el.classList.toggle('hidden', !n);
    }
    function yesNo(v) { return v ? 'Yes' : '<span class="subtle">No</span>'; }
    function pageHead(title, description, actionsHtml) {
        return '<div class="page-head"><div class="titles"><h1>' + esc(title) + '</h1>' + (description ? '<p>' + description + '</p>' : '') + '</div>' +
            (actionsHtml ? '<div class="row">' + actionsHtml + '</div>' : '') + '</div>';
    }
    function panel(title, body, opts) {
        opts = opts || {};
        return '<section class="panel' + (opts.cls ? ' ' + opts.cls : '') + '"' + (opts.id ? ' id="' + opts.id + '"' : '') + '><div class="panel-head"><h2>' + title + '</h2>' + (opts.actions || '') + '</div>' + body + '</section>';
    }
    function table(headers, rows, emptyText) {
        if (!rows.length) return '<div class="empty"><strong>' + esc(emptyText || 'Nothing here yet') + '</strong></div>';
        return '<div class="table-wrap"><table><thead><tr>' + headers.map(function (h) {
            return '<th' + (h.num ? ' class="num"' : '') + '>' + (h.label ? esc(h.label) : '<span class="sr-only">Actions</span>') + '</th>';
        }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }
    function time(ms) {
        if (!ms) return '-';
        var d = new Date(ms);
        var today = new Date().toDateString() === d.toDateString();
        var text = today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return '<span class="nowrap num" title="' + esc(d.toLocaleString()) + '">' + esc(text) + '</span>';
    }
    function statusBadge(code) {
        if (!code) return '<span class="badge bad">Failed</span>';
        var cls = code >= 500 ? 'bad' : code >= 400 ? 'warn' : 'ok';
        return '<span class="badge ' + cls + ' plain num">' + code + '</span>';
    }
    function proxyStatus(x) {
        if (!x.enabled) return '<span class="badge">Disabled</span>';
        if (x.status === 'unknown' && x.last_error) return '<span class="badge warn">Not responding</span>';
        var map = { healthy: ['ok', 'Online'], slow: ['warn', 'Slow'], dead: ['bad', 'Offline'], unknown: ['', 'Not checked'] };
        var m = map[x.status] || ['', x.status];
        return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
    }
    function poolName(id) {
        var p = state.pools.find(function (x) { return x.id === id; });
        return p ? p.name : '-';
    }
    function poolOptions(includeNone, noneLabel) {
        var opts = includeNone ? [{ value: '', label: noneLabel || '(none)' }] : [];
        return opts.concat(state.pools.filter(function (p) { return !p.owner_user_id; }).map(function (p) { return { value: String(p.id), label: p.name + (p.is_default ? ' (default)' : '') }; }));
    }
    async function loadPools() {
        var res = await P.api('GET', '/api/admin/pools');
        state.pools = res.pools;
        state.poolTypes = res.types;
    }
    function selectHtml(id, label, value, options) {
        return '<select id="' + id + '" aria-label="' + esc(label) + '">' + options.map(function (o) {
            return '<option value="' + o[0] + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    }
    var RANGES = [['1', 'Last hour'], ['6', 'Last 6 hours'], ['24', 'Last 24 hours'], ['72', 'Last 3 days'], ['168', 'Last 7 days']];

    // ---- small SVG charts (no library; CSP-safe) ----
    var W = 640, H = 150, PAD = { l: 52, r: 8, t: 8, b: 18 };
    function fmtNum(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10); }
    function axes(minT, maxT, maxV, unit) {
        var fmt = function (t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
        return '<line class="grid-line" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + PAD.t + '" y2="' + PAD.t + '"/>' +
            '<line class="grid-line" x1="' + PAD.l + '" x2="' + (W - PAD.r) + '" y1="' + (H - PAD.b) + '" y2="' + (H - PAD.b) + '"/>' +
            '<text class="axis" x="' + (PAD.l - 4) + '" y="' + (PAD.t + 8) + '" text-anchor="end">' + esc(fmtNum(maxV) + (unit || '')) + '</text>' +
            '<text class="axis" x="' + (PAD.l - 4) + '" y="' + (H - PAD.b) + '" text-anchor="end">0</text>' +
            '<text class="axis" x="' + PAD.l + '" y="' + (H - 4) + '">' + esc(fmt(minT)) + '</text>' +
            '<text class="axis" x="' + (W - PAD.r) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(fmt(maxT)) + '</text>';
    }
    /** series: [{ name, points: [[t, v], ...] }] */
    function lineChart(series, opts) {
        opts = opts || {};
        var pts = [].concat.apply([], series.map(function (s) { return s.points; })).filter(function (p) { return p[1] != null; });
        if (!pts.length) return '<div class="empty"><strong>No data yet</strong>Samples arrive every minute.</div>';
        var minT = Math.min.apply(null, pts.map(function (p) { return p[0]; }));
        var maxT = Math.max.apply(null, pts.map(function (p) { return p[0]; }));
        var maxV = Math.max(opts.min || 1, Math.max.apply(null, pts.map(function (p) { return p[1]; })));
        var x = function (t) { return PAD.l + (maxT === minT ? 0 : ((t - minT) / (maxT - minT)) * (W - PAD.l - PAD.r)); };
        var y = function (v) { return H - PAD.b - ((v || 0) / maxV) * (H - PAD.t - PAD.b); };
        var lines = series.map(function (s, i) {
            var valid = s.points.filter(function (p) { return p[1] != null; });
            if (!valid.length) return '';
            var last = valid[valid.length - 1];
            // the dot marks the latest value (and keeps a single sample visible)
            return '<polyline class="s' + (i % 4) + '" points="' + valid.map(function (p) { return x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1); }).join(' ') + '"/>' +
                '<circle class="p' + (i % 4) + '" r="3" cx="' + x(last[0]).toFixed(1) + '" cy="' + y(last[1]).toFixed(1) + '"><title>' + esc(s.name + ': ' + last[1]) + '</title></circle>';
        }).join('');
        return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'chart') + '">' + axes(minT, maxT, maxV, opts.unit) + lines + '</svg>' +
            '<div class="legend">' + series.map(function (s, i) { return '<span><i class="l' + (i % 4) + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>';
    }
    /** bars: [{ t, v, bad }] - failures drawn in red on top */
    function barChart(bars, opts) {
        opts = opts || {};
        if (!bars.length) return '<div class="empty"><strong>No traffic yet</strong></div>';
        var maxV = Math.max(1, Math.max.apply(null, bars.map(function (b) { return b.v; })));
        var bw = (W - PAD.l - PAD.r) / Math.max(bars.length, 24);
        var h = function (v) { return (v / maxV) * (H - PAD.t - PAD.b); };
        var rects = bars.map(function (b, i) {
            var x = PAD.l + i * bw + 1, w = Math.max(1, bw - 2);
            return '<rect class="bar" x="' + x.toFixed(1) + '" y="' + (H - PAD.b - h(b.v)).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h(b.v).toFixed(1) + '"><title>' + esc(new Date(b.t).toLocaleString() + ': ' + b.v + ' requests, ' + (b.bad || 0) + ' failed') + '</title></rect>' +
                (b.bad ? '<rect class="bar bad" x="' + x.toFixed(1) + '" y="' + (H - PAD.b - h(b.bad)).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h(b.bad).toFixed(1) + '"/>' : '');
        }).join('');
        return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'chart') + '">' + axes(bars[0].t, bars[bars.length - 1].t, maxV, '') + rects + '</svg>' +
            '<div class="legend"><span><i class="l0"></i>Requests (pages and portal)</span><span><i class="lbad"></i>Failed</span></div>';
    }

    // ================================================= side panel (drawer) ==
    var modal = P.$('#modal');
    var modalError = P.$('#modal-error');
    var lastFocus = null;
    function openDrawer(title, wide) {
        lastFocus = document.activeElement;
        P.$('#modal-title').textContent = title;
        P.showError(modalError, '');
        modal.querySelector('.drawer').classList.toggle('wide', !!wide);
        modal.classList.remove('hidden');
    }
    function closeModal() {
        modal.classList.add('hidden');
        P.$('#modal-body').innerHTML = '';
        if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) lastFocus.focus();
    }
    P.$('#modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.classList.contains('hidden') && !document.querySelector('.dialog-backdrop')) closeModal();
    });

    /**
     * openForm({ title, fields, submitLabel, onSubmit, wide })
     * field: { name, label, type: text|password|email|number|select|textarea|code|checkbox|users|info, value, options, hint, placeholder }
     * onSubmit(values) may return an HTML string to show instead of closing (e.g. a generated secret).
     */
    function openForm(cfg) {
        var html = cfg.fields.map(function (f) {
            var id = 'f-' + f.name;
            var val = f.value == null ? '' : f.value;
            var hint = f.hint ? '<div class="hint" id="' + id + '-hint">' + esc(f.hint) + '</div>' : '';
            var described = f.hint ? ' aria-describedby="' + id + '-hint"' : '';
            if (f.type === 'info') return '<div class="field">' + f.html + '</div>';
            if (f.type === 'checkbox') return '<label class="check"><input type="checkbox" id="' + id + '"' + (val ? ' checked' : '') + described + '> <span>' + esc(f.label) + '</span></label>' + hint;
            if (f.type === 'users') {
                return '<fieldset class="plain-fieldset"><legend>' + esc(f.label) + '</legend><div class="user-picker" id="' + id + '">' +
                    (f.options.length ? f.options.map(function (o) {
                        return '<label class="check"><input type="checkbox" value="' + o.value + '"' + (f.value.indexOf(o.value) !== -1 ? ' checked' : '') + '> <span>' + esc(o.label) + '</span></label>';
                    }).join('') : '<span class="muted">No users yet.</span>') + '</div>' + hint + '</fieldset>';
            }
            var input;
            if (f.type === 'select') {
                input = '<select id="' + id + '"' + described + '>' + f.options.map(function (o) {
                    return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(val) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
                }).join('') + '</select>';
            } else if (f.type === 'textarea' || f.type === 'code') {
                input = '<textarea id="' + id + '"' + (f.type === 'code' ? ' class="code" spellcheck="false"' : '') + described + ' placeholder="' + esc(f.placeholder || '') + '">' + esc(val) + '</textarea>';
            } else {
                input = '<input id="' + id + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off" autocapitalize="none"' + described + '>';
            }
            return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label>' + input + hint + '</div>';
        }).join('');

        openDrawer(cfg.title, cfg.wide);
        P.$('#modal-body').innerHTML = '<form id="modal-form" class="drawer-content" novalidate><div class="drawer-body">' + html + '</div>' +
            '<div class="drawer-foot"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="primary" id="modal-submit">' + esc(cfg.submitLabel || 'Save') + '</button></div></form>';
        P.$('#modal-cancel').addEventListener('click', closeModal);
        var first = P.$('#modal-form input:not([type=checkbox]), #modal-form textarea, #modal-form select');
        if (first && window.matchMedia('(pointer: fine)').matches) first.focus();

        P.$('#modal-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var values = {};
            cfg.fields.forEach(function (f) {
                if (f.type === 'info') return;
                var el = P.$('#f-' + f.name);
                if (f.type === 'users') { values[f.name] = P.$all('input:checked', el).map(function (i) { return Number(i.value); }); return; }
                values[f.name] = f.type === 'checkbox' ? el.checked : el.value;
            });
            var done = P.busy(P.$('#modal-submit'), 'Saving');
            P.showError(modalError, '');
            try {
                var result = await cfg.onSubmit(values);
                if (typeof result === 'string') {
                    P.$('#modal-body').innerHTML = '<div class="drawer-content"><div class="drawer-body">' + result + '</div><div class="drawer-foot"><button type="button" class="primary" id="modal-done">Done</button></div></div>';
                    P.$('#modal-done').addEventListener('click', closeModal);
                } else closeModal();
            } catch (err) {
                P.showError(modalError, err.message);
                done();
            }
        });
    }
    function showPanel(title, bodyHtml, footHtml, wide) {
        openDrawer(title, wide);
        P.$('#modal-body').innerHTML = '<div class="drawer-content"><div class="drawer-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="drawer-foot">' + footHtml + '</div>' : '') + '</div>';
    }
    function secretHtml(label, secret) {
        return '<h3>' + esc(label) + '</h3><div class="secret">' + esc(secret) + '</div><p class="hint">Copy it now. It is not shown again.</p>';
    }

    // ====================================================== labels & tones ==
    var EVENT_LABELS = {
        login: 'Signed in', logout: 'Signed out', login_failed: 'Sign-in failed', register: 'Signed up',
        password_changed: 'Password changed', session_start: 'Session started', session_end_requested: 'Session ended',
        session_refused: 'Session refused', session_failover: 'Proxy failover', sessions_expired: 'Sessions expired',
        blocked_domain: 'Blocked site', rate_limited: 'Rate limited', proxy_dead: 'Proxy offline', proxy_recovered: 'Proxy back online',
        user_proxies_added: 'Own proxies added', admin_user_created: 'User created', admin_user_updated: 'User updated',
        admin_user_deleted: 'User deleted', admin_user_approved: 'User approved', admin_pool_deleted: 'Pool deleted',
        admin_pool_access: 'Pool access changed', admin_proxies_imported: 'Proxies imported', admin_script_saved: 'Script saved',
        admin_settings_updated: 'Settings changed', admin_session_ended: 'Session ended by admin',
        process_start: 'Process started', process_stop: 'Process stopped', process_unclean_exit: 'Process crashed or killed'
    };
    var EVENT_TONE = { login_failed: 'bad', blocked_domain: 'bad', proxy_dead: 'bad', process_unclean_exit: 'bad', rate_limited: 'warn', session_refused: 'warn', session_failover: 'warn', register: 'accent', proxy_recovered: 'ok', login: 'ok', process_start: 'ok' };
    function eventLabel(type) { return EVENT_LABELS[type] || type.replace(/_/g, ' '); }
    function eventBadge(type) { return '<span class="badge ' + (EVENT_TONE[type] || '') + '" title="' + esc(type) + '">' + esc(eventLabel(type)) + '</span>'; }
    function eventsTable(list, empty) {
        return table([{ label: 'Time' }, { label: 'Event' }, { label: 'User' }, { label: 'Details' }, { label: 'IP' }], list.map(function (e) {
            return '<tr><td>' + time(e.created_at) + '</td><td>' + eventBadge(e.type) + '</td><td>' + esc(e.username || '-') + '</td><td class="small">' + esc(e.detail || '') + '</td><td class="mono subtle">' + esc(e.ip || '') + '</td></tr>';
        }), empty || 'No activity yet');
    }

    // ============================================================ dashboard ==
    async function dashboard() {
        var results = await Promise.all([P.api('GET', '/api/admin/overview'), P.api('GET', '/api/admin/server?hours=24'), loadPools()]);
        var o = results[0];
        var server = results[1];
        P.$('#release').textContent = o.release;
        setCount('#pending-count', o.pendingUsers);
        setCount('#error-count', o.openErrors);
        var stat = function (label, value, href, bad) {
            var inner = '<div class="label">' + esc(label) + '</div><div class="value' + (bad ? ' bad' : '') + '">' + esc(value) + '</div>';
            return href ? '<a class="stat" href="' + href + '">' + inner + '</a>' : '<div class="stat">' + inner + '</div>';
        };
        // Fixed 24 h axis in 10-minute slots, empty slots included, so the chart reads as a day.
        var slot = 600000;
        var end = Math.floor(Date.now() / slot) * slot;
        var byBucket = {};
        server.traffic.forEach(function (b) { byBucket[b.bucket] = b; });
        var bars = [];
        for (var t = end - 143 * slot; t <= end; t += slot) {
            var b = byBucket[t];
            bars.push({ t: t, v: b ? b.requests : 0, bad: b ? b.failures : 0 });
        }
        var adminPools = state.pools.filter(function (p) { return !p.owner_user_id; });
        view.innerHTML = pageHead('Dashboard', 'Usage, proxies and problems at a glance.') +
            '<div class="stats">' +
            stat('Active sessions', o.sessions.active, '#sessions') + stat('Sessions today', o.sessions.today) +
            stat('Users', o.users, '#users') + stat('Awaiting approval', o.pendingUsers, '#users', o.pendingUsers > 0) +
            stat('Usable proxies', o.usableProxies + ' / ' + o.proxies, '#pools', o.proxies > 0 && o.usableProxies === 0) +
            stat('Open errors', o.openErrors, '#errors', o.openErrors > 0) +
            stat('Traffic today', P.formatBytes(o.usageToday.bytes)) + stat('Requests today', o.usageToday.requests) +
            '</div>' +
            (o.proxies === 0 ? '<div class="alert warn mt">No upstream proxies yet. Add a pool under <a href="#pools">Proxy pools</a>, or allow direct connections in Settings.</div>' : '') +
            '<div class="grid main-side mt">' +
            panel('Traffic, last 24 hours', '<div class="panel-body">' + barChart(bars, { label: 'Requests per 10 minutes' }) + '</div>', { actions: '<a class="btn small" href="#server">Server health</a>' }) +
            panel('Proxy pools', table([{ label: 'Pool' }, { label: 'Online', num: true }, { label: 'Sessions', num: true }], adminPools.map(function (p) {
                var tone = p.proxy_count === 0 ? '' : p.usable_count === 0 ? 'bad' : p.usable_count < p.proxy_count ? 'warn' : 'ok';
                return '<tr><td class="cell-main">' + esc(p.name) + '</td><td class="num"><span class="badge ' + tone + ' plain">' + p.usable_count + ' / ' + p.proxy_count + '</span></td><td class="num">' + p.active_sessions + '</td></tr>';
            }), 'No pools yet'), { actions: '<a class="btn small" href="#pools">Manage</a>' }) +
            '</div>' +
            panel('Recent activity', eventsTable(o.recentEvents), { actions: '<a class="btn small" href="#logs">All activity</a>' });
    }

    // ================================================================ users ==
    async function usersView() {
        await loadPools();
        var all = await P.api('GET', '/api/admin/users');
        var pending = all.filter(function (u) { return u.pending; });
        var list = all.filter(function (u) { return !u.pending; });
        setCount('#pending-count', pending.length);
        view.innerHTML = pageHead('Users', 'Accounts, sign-in methods, proxy pools and limits.', '<button type="button" class="primary" id="add">Add user</button>') +
            (pending.length ? panel('Awaiting approval <span class="count">' + pending.length + '</span>', '<ul class="rows">' + pending.map(function (u) {
                return '<li><span class="avatar" aria-hidden="true">' + esc(u.username.charAt(0)) + '</span><div class="grow"><div class="title">' + esc(u.username) + '</div><div class="meta">' +
                    esc((u.email ? u.email + ' · ' : '') + 'signed up ' + P.timeAgo(u.created_at)) + '</div></div>' +
                    '<div class="actions"><button type="button" class="small primary" data-approve="' + u.id + '">Approve</button><button type="button" class="small danger" data-reject="' + u.id + '">Reject</button></div></li>';
            }).join('') + '</ul>') : '') +
            panel('All users <span class="muted">(' + list.length + ')</span>', table(
                [{ label: 'User' }, { label: 'Role' }, { label: 'Sign-in' }, { label: 'Pool' }, { label: 'Limits' }, { label: 'Last sign-in' }, { label: '' }],
                list.map(function (u) {
                    return '<tr><td><div class="cell-main">' + esc(u.username) + (u.enabled ? '' : ' <span class="badge bad">Disabled</span>') + '</div>' + (u.email || u.note ? '<div class="cell-sub">' + esc([u.email, u.note].filter(Boolean).join(' · ')) + '</div>' : '') + '</td>' +
                        '<td>' + (u.role === 'admin' ? '<span class="badge accent plain">Admin</span>' : 'User') + '</td>' +
                        '<td class="small">' + [u.has_password ? 'Password' : '', u.has_token ? 'Access code' : ''].filter(Boolean).join(', ') + '</td>' +
                        '<td>' + esc(u.pool_id ? poolName(u.pool_id) : 'Automatic') + '</td>' +
                        '<td class="small">' + (u.rate_limit_rpm != null ? esc(u.rate_limit_rpm) + '/min' : 'Default') + ' · ' + (u.bandwidth_limit_mb_day != null ? (u.bandwidth_limit_mb_day ? esc(u.bandwidth_limit_mb_day) + ' MB/day' : 'Unlimited') : 'Default') + '</td>' +
                        '<td>' + (u.last_login_at ? time(u.last_login_at) : '<span class="subtle">Never</span>') + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-edit="' + u.id + '">Edit</button><button type="button" class="small" data-token="' + u.id + '">New code</button><button type="button" class="small danger" data-del="' + u.id + '" aria-label="Delete ' + esc(u.username) + '">Delete</button></td></tr>';
                }), 'No users'));

        on('[data-approve]', 'click', async function (btn) {
            try {
                var u = await P.api('POST', '/api/admin/users/' + btn.getAttribute('data-approve') + '/approve');
                P.toast(u.username + ' can sign in now');
                usersView();
            } catch (err) { P.toast(err.message); }
        });
        on('[data-reject]', 'click', function (btn) {
            confirmed('The sign-up request is deleted.', async function () {
                await P.api('DELETE', '/api/admin/users/' + btn.getAttribute('data-reject'));
                P.toast('Request rejected');
                usersView();
            }, { title: 'Reject this sign-up?', confirmLabel: 'Reject', danger: true });
        });
        P.$('#add').addEventListener('click', function () {
            openForm({
                title: 'Add user',
                fields: [
                    { name: 'username', label: 'Username' },
                    { name: 'email', label: 'E-mail (optional)', type: 'email' },
                    { name: 'password', label: 'Password', type: 'password', hint: 'At least 8 characters. Leave empty to use an access code only.' },
                    { name: 'generateToken', label: 'Also create an access code (sign in without a username)', type: 'checkbox' },
                    { name: 'role', label: 'Role', type: 'select', value: 'user', options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }] },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', options: poolOptions(true, 'Automatic (site rule / default pool)') },
                    { name: 'rateLimitRpm', label: 'Requests per minute', type: 'number', placeholder: 'Empty = default' },
                    { name: 'bandwidthLimitMbDay', label: 'Traffic per day (MB)', type: 'number', placeholder: 'Empty = default, 0 = unlimited' },
                    { name: 'note', label: 'Note' }
                ],
                submitLabel: 'Create user',
                onSubmit: async function (v) {
                    var res = await P.api('POST', '/api/admin/users', v);
                    usersView();
                    return res.accessToken ? secretHtml('Access code for ' + res.user.username, res.accessToken) : undefined;
                }
            });
        });
        on('[data-edit]', 'click', function (btn) {
            var u = list.find(function (x) { return x.id === Number(btn.getAttribute('data-edit')); });
            openForm({
                title: 'Edit ' + u.username,
                fields: [
                    { name: 'enabled', label: 'Account enabled', type: 'checkbox', value: !!u.enabled },
                    { name: 'role', label: 'Role', type: 'select', value: u.role, options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }] },
                    { name: 'email', label: 'E-mail', type: 'email', value: u.email || '' },
                    { name: 'password', label: 'New password', type: 'password', hint: 'Leave empty to keep the current password. Changing it signs the user out.' },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', value: u.pool_id || '', options: poolOptions(true, 'Automatic (site rule / default pool)') },
                    { name: 'rateLimitRpm', label: 'Requests per minute', type: 'number', value: u.rate_limit_rpm, placeholder: 'Empty = default' },
                    { name: 'bandwidthLimitMbDay', label: 'Traffic per day (MB)', type: 'number', value: u.bandwidth_limit_mb_day, placeholder: 'Empty = default, 0 = unlimited' },
                    { name: 'note', label: 'Note', value: u.note || '' },
                    { name: 'logoutEverywhere', label: 'Sign out everywhere and end all sessions', type: 'checkbox' }
                ],
                onSubmit: async function (v) {
                    var patch = { enabled: v.enabled, role: v.role, email: v.email, poolId: v.poolId ? Number(v.poolId) : null, rateLimitRpm: v.rateLimitRpm, bandwidthLimitMbDay: v.bandwidthLimitMbDay, note: v.note };
                    if (v.password) patch.password = v.password;
                    await P.api('PATCH', '/api/admin/users/' + u.id, patch);
                    if (v.logoutEverywhere) await P.api('POST', '/api/admin/users/' + u.id + '/logout');
                    P.toast('Saved');
                    usersView();
                }
            });
        });
        on('[data-token]', 'click', function (btn) {
            confirmed('The old access code stops working.', async function () {
                var res = await P.api('POST', '/api/admin/users/' + btn.getAttribute('data-token') + '/token');
                showPanel('New access code', secretHtml('Access code', res.accessToken), '<button type="button" class="primary" id="modal-done">Done</button>');
                P.$('#modal-done').addEventListener('click', closeModal);
                usersView();
            }, { title: 'Create a new access code?', confirmLabel: 'Create code' });
        });
        on('[data-del]', 'click', function (btn) {
            confirmed('The user is deleted and their sessions end.', async function () {
                await P.api('DELETE', '/api/admin/users/' + btn.getAttribute('data-del'));
                usersView();
            }, { title: 'Delete this user?', confirmLabel: 'Delete', danger: true });
        });
    }

    // ================================================================ pools ==
    async function poolsView() {
        await loadPools();
        view.innerHTML = pageHead('Proxy pools', 'Each browsing session stays on one proxy of its pool until it ends. Pool choice: the user’s pick, the user’s assigned pool, the matching site, then the default pool.', '<button type="button" class="primary" id="add">Add pool</button>') +
            panel('Pools <span class="muted">(' + state.pools.length + ')</span>', table(
                [{ label: 'Pool' }, { label: 'Type' }, { label: 'Who can use it' }, { label: 'Proxies', num: true }, { label: 'Online', num: true }, { label: 'Sessions', num: true }, { label: '' }],
                state.pools.map(function (p) {
                    var who = p.owner_user_id ? '<span class="badge plain">Personal · ' + esc(p.owner_username) + '</span>'
                        : p.visibility === 'all' ? '<span class="badge ok plain">All users</span>'
                        : '<span class="badge warn plain">' + p.assigned_count + ' assigned user' + (p.assigned_count === 1 ? '' : 's') + '</span>';
                    return '<tr><td><span class="cell-main">' + esc(p.name) + '</span>' + (p.is_default ? ' <span class="badge accent plain">Default</span>' : '') + (p.country ? ' <span class="subtle">' + esc(p.country) + '</span>' : '') + '</td>' +
                        '<td>' + esc(p.type) + '</td><td>' + who + '</td><td class="num">' + p.proxy_count + '</td><td class="num">' + p.usable_count + '</td><td class="num">' + p.active_sessions + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-open="' + p.id + '">Proxies</button>' +
                        (p.owner_user_id ? '' : '<button type="button" class="small" data-access="' + p.id + '">Users</button><button type="button" class="small" data-edit="' + p.id + '">Edit</button>') +
                        '<button type="button" class="small danger" data-del="' + p.id + '" aria-label="Delete pool ' + esc(p.name) + '">Delete</button></td></tr>';
                }), 'No pools yet. Add one, then import your proxy list.')) +
            '<div id="pool-detail"></div>';

        P.$('#add').addEventListener('click', function () { poolForm(null); });
        on('[data-edit]', 'click', function (btn) { poolForm(state.pools.find(function (p) { return p.id === Number(btn.getAttribute('data-edit')); })); });
        on('[data-del]', 'click', function (btn) {
            confirmed('All proxies of this pool are deleted. Sessions using them lose their proxy.', async function () {
                await P.api('DELETE', '/api/admin/pools/' + btn.getAttribute('data-del'));
                poolsView();
            }, { title: 'Delete this pool?', confirmLabel: 'Delete pool', danger: true });
        });
        on('[data-open]', 'click', function (btn) { poolDetail(Number(btn.getAttribute('data-open'))); });
        on('[data-access]', 'click', function (btn) { poolAccess(state.pools.find(function (p) { return p.id === Number(btn.getAttribute('data-access')); })); });
        if (state.pools.length === 1) poolDetail(state.pools[0].id);
    }

    function poolForm(p) {
        openForm({
            title: p ? 'Edit pool' : 'Add pool',
            fields: [
                { name: 'name', label: 'Name', value: p && p.name, placeholder: 'US residential' },
                { name: 'type', label: 'Type', type: 'select', value: p ? p.type : 'residential', options: state.poolTypes.map(function (t) { return { value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }; }) },
                { name: 'country', label: 'Country tag', value: p && p.country, placeholder: 'US' },
                { name: 'visibility', label: 'Who can use this pool', type: 'select', value: p ? p.visibility : 'all', options: [{ value: 'all', label: 'All users' }, { value: 'assigned', label: 'Only users I assign' }], hint: 'With "Only users I assign", choose the users with the Users button.' },
                { name: 'description', label: 'Description', value: p && p.description },
                { name: 'isDefault', label: 'Default pool (used when no other rule applies)', type: 'checkbox', value: p ? !!p.is_default : state.pools.filter(function (x) { return !x.owner_user_id; }).length === 0 }
            ],
            submitLabel: p ? 'Save' : 'Create pool',
            onSubmit: async function (v) {
                if (p) await P.api('PUT', '/api/admin/pools/' + p.id, v);
                else await P.api('POST', '/api/admin/pools', v);
                poolsView();
            }
        });
    }

    async function poolAccess(pool) {
        var users = await P.api('GET', '/api/admin/users');
        var access = await P.api('GET', '/api/admin/pools/' + pool.id + '/access');
        openForm({
            title: 'Users of ' + pool.name,
            fields: [
                { type: 'info', name: 'i', html: '<p class="muted">' + (pool.visibility === 'all'
                    ? 'This pool is visible to <strong>all users</strong>. Assignments apply once it is set to "Only users I assign" (Edit).'
                    : 'Only the users ticked here (and admins) can browse through this pool.') + '</p>' },
                { name: 'userIds', label: 'Allowed users', type: 'users', value: access.userIds,
                  options: users.filter(function (u) { return u.role !== 'admin' && !u.pending; }).map(function (u) { return { value: u.id, label: u.username + (u.email ? ' (' + u.email + ')' : '') }; }) }
            ],
            submitLabel: 'Save access',
            onSubmit: async function (v) {
                await P.api('PUT', '/api/admin/pools/' + pool.id + '/access', { userIds: v.userIds });
                P.toast('Access saved');
                poolsView();
            }
        });
    }

    async function poolDetail(poolId) {
        var pool = state.pools.find(function (p) { return p.id === poolId; });
        var proxies = await P.api('GET', '/api/admin/pools/' + poolId + '/proxies');
        var box = P.$('#pool-detail');
        box.innerHTML = panel(esc(pool.name) + ' <span class="muted">· ' + proxies.length + ' proxies</span>',
            table([{ label: 'Proxy' }, { label: 'Status' }, { label: 'Latency', num: true }, { label: 'Sessions', num: true }, { label: 'Last check' }, { label: '' }], proxies.map(function (x) {
                return '<tr><td><span class="mono">' + esc(x.protocol + '://' + (x.username ? x.username + ':•••@' : '') + x.host + ':' + x.port) + '</span>' +
                    (x.last_error && x.status !== 'healthy' ? '<div class="cell-sub">' + esc(x.last_error) + '</div>' : '') + '</td>' +
                    '<td>' + proxyStatus(x) + '</td><td class="num">' + (x.latency_ms != null ? x.latency_ms + ' ms' : '-') + '</td><td class="num">' + x.active_sessions + '</td>' +
                    '<td>' + (x.last_checked_at ? time(x.last_checked_at) : '<span class="subtle">Never</span>') + '</td>' +
                    '<td class="actions"><button type="button" class="small" data-history="' + x.id + '">History</button><button type="button" class="small" data-toggle="' + x.id + '" data-enabled="' + x.enabled + '">' + (x.enabled ? 'Disable' : 'Enable') + '</button><button type="button" class="small danger" data-remove="' + x.id + '">Remove</button></td></tr>';
            }), 'No proxies in this pool yet. Use Import.'),
            { cls: 'mt', actions: '<button type="button" class="small" id="check">Check now</button><button type="button" class="small" id="purge">Remove offline</button><button type="button" class="small primary" id="import">Import</button>' });

        P.$('#import').addEventListener('click', function () {
            openForm({
                title: 'Import proxies into ' + pool.name,
                fields: [
                    { name: 'text', label: 'Proxy list (one per line)', type: 'code', placeholder: 'http://user:pass@1.2.3.4:8080\nsocks5://user:pass@1.2.3.4:1080\n1.2.3.4:8080:user:pass', hint: 'Formats: http://user:pass@ip:port, socks5://user:pass@ip:port, ip:port:user:pass (Webshare), ip:port.' },
                    { name: 'defaultProtocol', label: 'Protocol for lines without a scheme', type: 'select', value: 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }] }
                ],
                submitLabel: 'Import',
                onSubmit: async function (v) {
                    var r = await P.api('POST', '/api/admin/pools/' + poolId + '/import', v);
                    await loadPools();
                    poolDetail(poolId);
                    return '<p>Added <strong>' + r.added + '</strong>, skipped ' + r.skipped + ' already in the pool. A health check is running.</p>' +
                        (r.errors.length ? '<div class="alert error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
                }
            });
        });
        P.$('#check').addEventListener('click', async function () {
            var done = P.busy(P.$('#check'), 'Checking');
            try {
                var r = await P.api('POST', '/api/admin/pools/' + poolId + '/check');
                P.toast('Checked ' + r.checked + ': ' + (r.healthy || 0) + ' online, ' + (r.slow || 0) + ' slow, ' + (r.dead || 0) + ' offline');
            } catch (err) { P.toast(err.message); done(); }
            poolDetail(poolId);
        });
        P.$('#purge').addEventListener('click', function () {
            confirmed('Proxies marked Offline are removed from this pool.', async function () {
                var r = await P.api('DELETE', '/api/admin/pools/' + poolId + '/dead');
                P.toast('Removed ' + r.deleted);
                poolDetail(poolId);
            }, { title: 'Remove offline proxies?', confirmLabel: 'Remove', danger: true });
        });
        on('[data-toggle]', 'click', async function (btn) {
            await P.api('PATCH', '/api/admin/proxies/' + btn.getAttribute('data-toggle'), { enabled: btn.getAttribute('data-enabled') !== '1' });
            poolDetail(poolId);
        }, box);
        on('[data-remove]', 'click', function (btn) {
            confirmed('The proxy is removed from the pool.', async function () {
                await P.api('DELETE', '/api/admin/proxies/' + btn.getAttribute('data-remove'));
                poolDetail(poolId);
            }, { title: 'Remove this proxy?', confirmLabel: 'Remove', danger: true });
        }, box);
        on('[data-history]', 'click', async function (btn) {
            var checks = await P.api('GET', '/api/admin/proxies/' + btn.getAttribute('data-history') + '/checks');
            var pts = checks.slice().reverse().filter(function (c) { return c.ok; }).map(function (c) { return [c.ts, c.latency_ms]; });
            var fails = checks.filter(function (c) { return !c.ok; }).length;
            showPanel('Health history', '<p class="muted">' + checks.length + ' checks, ' + fails + ' failed.</p>' +
                lineChart([{ name: 'Latency (ms)', points: pts }], { unit: ' ms', label: 'Latency per check' }) +
                '<h3>Checks</h3>' + table([{ label: 'Time' }, { label: 'Result' }, { label: 'Latency', num: true }, { label: 'Error' }], checks.map(function (c) {
                    return '<tr><td>' + time(c.ts) + '</td><td>' + (c.ok ? '<span class="badge ok">OK</span>' : '<span class="badge bad">Failed</span>') + '</td><td class="num">' + (c.latency_ms != null ? c.latency_ms + ' ms' : '-') + '</td><td class="small">' + esc(c.error || '') + '</td></tr>';
                }), 'Not checked yet'), null, true);
        }, box);
    }

    // ============================================================= sessions ==
    async function sessionsView() {
        var list = await P.api('GET', '/api/admin/sessions');
        view.innerHTML = pageHead('Sessions', 'Active browsing sessions. Open the timeline to see every page a session loaded.', '<button type="button" id="reload">Refresh</button>') +
            panel('Active <span class="muted">(' + list.length + ')</span>', table(
                [{ label: 'User' }, { label: 'Start page' }, { label: 'Upstream' }, { label: 'Traffic', num: true }, { label: 'Requests', num: true }, { label: 'Last seen' }, { label: '' }],
                list.map(function (s) {
                    return '<tr><td><div class="cell-main">' + esc(s.username) + '</div><div class="cell-sub mono">' + esc(s.client_ip || '') + '</div></td>' +
                        '<td class="small"><div class="truncate maxw" title="' + esc(s.start_url || '') + '">' + esc(s.start_url || '') + '</div></td>' +
                        '<td class="small">' + esc(s.pool_name || '-') + '<div class="cell-sub mono">' + esc(s.proxy_host ? s.proxy_host + ':' + s.proxy_port : 'direct') + '</div></td>' +
                        '<td class="num">' + esc(P.formatBytes(s.bytes)) + '</td><td class="num">' + s.requests + '</td><td>' + time(s.last_seen_at) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-show="' + esc(s.id) + '">Timeline</button><button type="button" class="small danger" data-end="' + esc(s.id) + '">End</button></td></tr>';
                }), 'No active sessions'));
        P.$('#reload').addEventListener('click', sessionsView);
        on('[data-show]', 'click', function (btn) { sessionTimeline(btn.getAttribute('data-show')); });
        on('[data-end]', 'click', function (btn) {
            confirmed('The user will need to start a new session.', async function () {
                await P.api('POST', '/api/admin/sessions/' + encodeURIComponent(btn.getAttribute('data-end')) + '/end');
                P.toast('Session will end within a few seconds');
                sessionsView();
            }, { title: 'End this session?', confirmLabel: 'End session', danger: true });
        });
    }

    async function sessionTimeline(id) {
        var d = await P.api('GET', '/api/admin/sessions/' + encodeURIComponent(id) + '/timeline');
        var s = d.session;
        showPanel('Session ' + id.slice(0, 8), '<dl class="kv">' +
            '<dt>User</dt><dd>' + esc(s.username || '-') + '</dd><dt>Started</dt><dd>' + esc(P.formatDate(s.created_at)) + '</dd>' +
            '<dt>Start page</dt><dd>' + esc(s.start_url || '-') + '</dd><dt>Traffic</dt><dd>' + esc(P.formatBytes(s.bytes)) + ' · ' + s.requests + ' requests</dd>' +
            '<dt>Status</dt><dd>' + (s.ended_at ? 'Ended ' + esc(P.timeAgo(s.ended_at)) + (s.end_reason ? ' (' + esc(s.end_reason) + ')' : '') : 'Active') + '</dd></dl>' +
            '<h3>Pages and failures (' + d.requests.length + ')</h3>' +
            table([{ label: 'Time' }, { label: 'Result' }, { label: 'Duration', num: true }, { label: 'Size', num: true }, { label: 'Address' }], d.requests.slice().reverse().map(function (r) {
                return '<tr><td>' + time(r.ts) + '</td><td>' + statusBadge(r.status) + '</td><td class="num">' + (r.ms != null ? r.ms + ' ms' : '-') + '</td><td class="num">' + (r.bytes != null ? esc(P.formatBytes(r.bytes)) : '-') + '</td>' +
                    '<td class="small">' + esc(r.url || '') + (r.error ? '<div class="cell-sub">' + esc(r.error) + '</div>' : '') + '</td></tr>';
            }), 'Nothing logged yet. Pages appear here within a few seconds.'), null, true);
    }

    // ================================================================ sites ==
    async function sitesView() {
        await loadPools();
        var list = await P.api('GET', '/api/admin/sites');
        view.innerHTML = pageHead('Sites', 'Shortcuts on the Browse page. A site can use its own proxy pool, and sites form the domain allowlist when it is enabled.', '<button type="button" class="primary" id="add">Add site</button>') +
            panel('Sites <span class="muted">(' + list.length + ')</span>', table(
                [{ label: 'Site' }, { label: 'Domains' }, { label: 'Pool' }, { label: 'Enabled' }, { label: 'On Browse' }, { label: '' }],
                list.map(function (s) {
                    return '<tr><td><div class="cell-main">' + esc(s.name) + '</div><div class="cell-sub">' + esc(s.start_url) + '</div></td><td class="mono small">' + esc(s.domains) + '</td>' +
                        '<td>' + esc(s.pool_id ? poolName(s.pool_id) : 'Default') + '</td><td>' + yesNo(s.enabled) + '</td><td>' + yesNo(s.show_on_landing) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-edit="' + s.id + '">Edit</button><button type="button" class="small danger" data-del="' + s.id + '">Delete</button></td></tr>';
                }), 'No sites yet'));
        function form(s) {
            openForm({
                title: s ? 'Edit site' : 'Add site',
                fields: [
                    { name: 'name', label: 'Name', value: s && s.name, placeholder: 'Example' },
                    { name: 'startUrl', label: 'Start URL', value: s && s.start_url, placeholder: 'https://www.example.com/' },
                    { name: 'domains', label: 'Domain patterns', value: s ? s.domains : '', placeholder: '*.example.com, examplecdn.net', hint: 'Comma separated. *.example.com covers example.com and its subdomains. Include the login and CDN domains the site uses.' },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', value: s ? s.pool_id || '' : '', options: poolOptions(true, 'Default pool') },
                    { name: 'sortOrder', label: 'Order', type: 'number', value: s ? s.sort_order : 0 },
                    { name: 'enabled', label: 'Enabled', type: 'checkbox', value: s ? !!s.enabled : true },
                    { name: 'showOnLanding', label: 'Show on the Browse page', type: 'checkbox', value: s ? !!s.show_on_landing : true }
                ],
                submitLabel: s ? 'Save' : 'Add site',
                onSubmit: async function (v) {
                    if (s) await P.api('PUT', '/api/admin/sites/' + s.id, v);
                    else await P.api('POST', '/api/admin/sites', v);
                    sitesView();
                }
            });
        }
        P.$('#add').addEventListener('click', function () { form(null); });
        on('[data-edit]', 'click', function (btn) { form(list.find(function (s) { return s.id === Number(btn.getAttribute('data-edit')); })); });
        on('[data-del]', 'click', function (btn) {
            confirmed('The site is removed from the Browse page and the allowlist.', async function () {
                await P.api('DELETE', '/api/admin/sites/' + btn.getAttribute('data-del'));
                sitesView();
            }, { title: 'Delete this site?', confirmLabel: 'Delete', danger: true });
        });
    }

    // ============================================================== scripts ==
    async function scriptsView() {
        var res = await P.api('GET', '/api/admin/scripts');
        var list = res.scripts;
        view.innerHTML = pageHead('Scripts', 'JavaScript added to matching proxied pages, lowest order first. Inside a script, <code>window.__portal.page.url</code> and <code>.host</code> give the real address. Changes apply within a few seconds.', '<button type="button" class="primary" id="add">Add script</button>') +
            panel('Scripts <span class="muted">(' + list.length + ')</span>', table(
                [{ label: 'Order', num: true }, { label: 'Script' }, { label: 'Domains' }, { label: 'Runs' }, { label: 'Enabled' }, { label: '' }],
                list.map(function (s) {
                    return '<tr><td class="num">' + s.load_order + '</td><td><div class="cell-main">' + esc(s.name) + '</div><div class="cell-sub">' + esc(P.formatBytes(s.code.length)) + ' · updated ' + esc(P.timeAgo(s.updated_at)) + '</div></td>' +
                        '<td class="mono small">' + esc(s.domains) + '</td><td class="small">' + esc(s.run_at) + '</td><td>' + yesNo(s.enabled) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-edit="' + s.id + '">Edit</button><button type="button" class="small danger" data-del="' + s.id + '">Delete</button></td></tr>';
                }), 'No scripts yet. Examples: sudo portal-cli seed-examples'));
        function form(s) {
            openForm({
                title: s ? 'Edit script' : 'Add script',
                wide: true,
                fields: [
                    { name: 'name', label: 'Name', value: s && s.name },
                    { name: 'domains', label: 'Run on domains', value: s ? s.domains : '*', hint: 'Comma separated patterns. * = every site.' },
                    { name: 'runAt', label: 'Run at', type: 'select', value: s ? s.run_at : 'document-end', options: res.runAt.map(function (r) { return { value: r, label: r }; }), hint: 'document-end (recommended) runs when the page HTML is ready.' },
                    { name: 'loadOrder', label: 'Order', type: 'number', value: s ? s.load_order : 100 },
                    { name: 'enabled', label: 'Enabled', type: 'checkbox', value: s ? !!s.enabled : true },
                    { name: 'code', label: 'JavaScript', type: 'code', value: s ? s.code : '// Example\nvar note = document.createElement("div");\nnote.textContent = "Viewing " + window.__portal.page.host;\ndocument.body.prepend(note);\n' }
                ],
                submitLabel: s ? 'Save' : 'Add script',
                onSubmit: async function (v) {
                    if (s) await P.api('PUT', '/api/admin/scripts/' + s.id, v);
                    else await P.api('POST', '/api/admin/scripts', v);
                    P.toast('Saved');
                    scriptsView();
                }
            });
        }
        P.$('#add').addEventListener('click', function () { form(null); });
        on('[data-edit]', 'click', function (btn) { form(list.find(function (s) { return s.id === Number(btn.getAttribute('data-edit')); })); });
        on('[data-del]', 'click', function (btn) {
            confirmed('The script stops running on all pages.', async function () {
                await P.api('DELETE', '/api/admin/scripts/' + btn.getAttribute('data-del'));
                scriptsView();
            }, { title: 'Delete this script?', confirmLabel: 'Delete', danger: true });
        });
    }

    // ============================================================= requests ==
    var reqFilter = { q: '', kind: 'activity', status: '', hours: '24' };
    async function requestsView() {
        var qs = 'hours=' + reqFilter.hours + (reqFilter.q ? '&q=' + encodeURIComponent(reqFilter.q) : '') + (reqFilter.kind ? '&kind=' + reqFilter.kind : '') + (reqFilter.status ? '&status=' + reqFilter.status : '');
        var rows = await P.api('GET', '/api/admin/requests?' + qs + '&limit=300');
        var TYPE = { page: 'Page', resource: 'Resource', api: 'API', view: 'Portal page' };
        view.innerHTML = pageHead('Requests', 'What users did: pages opened through the proxy, portal actions and every failure. Successful images and scripts are only stored with REQUEST_LOG_LEVEL=all.',
            '<a class="btn" href="/api/admin/requests.csv?' + qs + '" download>Export CSV</a>') +
            '<section class="panel"><div class="toolbar">' +
            '<input type="search" id="rq" placeholder="Search user, site, URL or request id" value="' + esc(reqFilter.q) + '" aria-label="Search requests">' +
            selectHtml('rkind', 'Type', reqFilter.kind, [['activity', 'User activity'], ['', 'All requests'], ['page', 'Proxied pages'], ['resource', 'Proxied resources'], ['api', 'Portal API'], ['view', 'Portal pages']]) +
            selectHtml('rstatus', 'Result', reqFilter.status, [['', 'All results'], ['failed', 'Failed only'], ['ok', 'Successful only']]) +
            selectHtml('rhours', 'Time range', reqFilter.hours, RANGES) +
            '<span class="muted small">' + rows.length + (rows.length === 300 ? '+' : '') + ' shown</span></div>' +
            table([{ label: 'Time' }, { label: 'User' }, { label: 'Type' }, { label: 'Result' }, { label: 'Duration', num: true }, { label: 'Size', num: true }, { label: 'Address' }, { label: '' }], rows.map(function (r) {
                return '<tr><td>' + time(r.ts) + '</td><td>' + esc(r.username || '-') + '</td><td class="small nowrap">' + esc(TYPE[r.kind] || r.kind) + ' <span class="subtle">' + esc(r.method || '') + '</span></td>' +
                    '<td>' + statusBadge(r.status) + '</td><td class="num">' + (r.ms != null ? r.ms + ' ms' : '-') + '</td><td class="num">' + (r.bytes != null ? esc(P.formatBytes(r.bytes)) : '-') + '</td>' +
                    '<td class="small"><div class="truncate maxw" title="' + esc(r.url || '') + '">' + esc(r.url || '') + '</div>' + (r.error ? '<div class="cell-sub">' + esc(r.error) + '</div>' : '') + '</td>' +
                    '<td class="actions">' + (r.session_id ? '<button type="button" class="small" data-session="' + esc(r.session_id) + '">Session</button>' : '') + '</td></tr>';
            }), 'No requests match') + '</section>';
        var t;
        P.$('#rq').addEventListener('input', function (e) {
            clearTimeout(t);
            t = setTimeout(function () { reqFilter.q = e.target.value.trim(); requestsView().then(function () { var n = P.$('#rq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 350);
        });
        [['#rkind', 'kind'], ['#rstatus', 'status'], ['#rhours', 'hours']].forEach(function (p) { P.$(p[0]).addEventListener('change', function (e) { reqFilter[p[1]] = e.target.value; requestsView(); }); });
        on('[data-session]', 'click', function (btn) { sessionTimeline(btn.getAttribute('data-session')); });
    }

    // =============================================================== errors ==
    var KIND_LABELS = {
        page_load_failed: 'Page failed to load', site_error: 'Site returned an error', upstream_auth_failed: 'Upstream proxy login rejected',
        server_exception: 'Server error', process_exception: 'Process error', client_js: 'Browser error', client_promise: 'Browser error',
        api_error: 'API call failed', network_error: 'Network error'
    };
    var errorFilter = { status: 'open', q: '' };
    function kindLabel(k) { return KIND_LABELS[k] || k.replace(/_/g, ' '); }
    function sevBadge(r) { return '<span class="badge ' + (r.severity === 'warning' ? 'warn' : 'bad') + '">' + esc(kindLabel(r.kind)) + '</span>'; }

    async function errorsView() {
        var res = await P.api('GET', '/api/admin/errors?status=' + errorFilter.status + '&q=' + encodeURIComponent(errorFilter.q));
        setCount('#error-count', res.open);
        var list = res.reports;
        view.innerHTML = pageHead('Errors', 'Each report holds the steps the user took before the failure, so it can be reproduced. Users see the reference (e.g. E-7K2P9Q) on the error page.', '<a class="btn" href="/api/admin/errors.jsonl?days=30" download>Export (JSON Lines)</a>') +
            '<section class="panel"><div class="toolbar"><div class="seg" role="group" aria-label="Status">' + ['open', 'resolved', 'all'].map(function (st) {
                return '<button type="button" data-filter="' + st + '" class="' + (errorFilter.status === st ? 'active' : '') + '" aria-pressed="' + (errorFilter.status === st) + '">' + st.charAt(0).toUpperCase() + st.slice(1) + '</button>';
            }).join('') + '</div>' +
            '<input type="search" id="error-q" placeholder="Search reference, message, site, user" value="' + esc(errorFilter.q) + '" aria-label="Search errors">' +
            '<span class="muted small">' + list.length + ' shown</span></div>' +
            table([{ label: 'Reference' }, { label: 'What' }, { label: 'Where' }, { label: 'User' }, { label: 'Message' }, { label: 'Last seen' }, { label: '' }], list.map(function (r) {
                var where = r.dest_host || (r.url || '').split('?')[0] || '-';
                return '<tr><td class="mono nowrap">' + esc(r.ref) + (r.resolved ? ' <span class="badge ok plain">Resolved</span>' : '') + '</td>' +
                    '<td>' + sevBadge(r) + '<div class="cell-sub">' + esc(r.source) + '</div></td>' +
                    '<td class="small">' + esc(where.slice(0, 60)) + '</td><td>' + esc(r.username || '-') + '</td>' +
                    '<td class="small"><div class="truncate maxw" title="' + esc(r.message) + '">' + esc(r.message) + '</div></td>' +
                    '<td>' + time(r.last_seen_at) + (r.occurrences > 1 || r.group_count > 1 ? '<div class="cell-sub">' + (r.occurrences > 1 ? '×' + r.occurrences + ' ' : '') + (r.group_count > 1 ? r.group_count + ' similar' : '') + '</div>' : '') + '</td>' +
                    '<td class="actions"><button type="button" class="small" data-view="' + esc(r.ref) + '">View</button></td></tr>';
            }), errorFilter.status === 'open' ? 'No open errors' : 'Nothing found') + '</section>';
        on('[data-filter]', 'click', function (b) { errorFilter.status = b.getAttribute('data-filter'); errorsView(); });
        var q = P.$('#error-q');
        var timer;
        q.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () { errorFilter.q = q.value.trim(); errorsView().then(function () { var n = P.$('#error-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 350);
        });
        on('[data-view]', 'click', function (btn) { showErrorReport(btn.getAttribute('data-view')); });
    }

    function describeCrumb(c) {
        var st = c.status != null && c.status !== '' ? ' → ' + c.status : '';
        var ms = c.ms != null ? ' (' + c.ms + ' ms)' : '';
        switch (c.type) {
            case 'event': return eventLabel(c.event) + (c.detail ? ': ' + c.detail : '');
            case 'page': return 'Opened ' + (c.url || '') + st + ms + (c.error ? ' [' + c.error + ']' : '');
            case 'resource': return 'Loaded ' + (c.url || '') + st + ms;
            case 'api': return 'Portal ' + (c.method || '') + ' ' + (c.url || '') + st + ms;
            case 'browser:click': return 'Pressed “' + (c.label || '') + '”' + (c.url ? ' on ' + c.url : '');
            case 'browser:submit': return 'Submitted form ' + (c.label || '') + (c.url ? ' on ' + c.url : '');
            case 'browser:page': return 'Viewed ' + (c.url || '') + (c.label ? ' (' + c.label + ')' : '');
            case 'browser:api': return 'Browser called ' + (c.label || '') + st + ms;
            default: return (c.type || 'step') + ' ' + (c.label || c.url || '') + st;
        }
    }
    function crumbTone(c) {
        var s = c.status;
        if (s === 'failed' || s === 'aborted' || s === 'network-error' || s === 0 || (typeof s === 'number' && s >= 400) || c.event === 'login_failed') return 'bad';
        return '';
    }

    async function showErrorReport(ref) {
        var r = await P.api('GET', '/api/admin/errors/' + encodeURIComponent(ref));
        var t0 = r.created_at;
        var rel = function (t) { var d = Math.round((t - t0) / 1000); return d === 0 ? '0s' : (d > 0 ? '+' : '−') + Math.abs(d) + 's'; };
        var steps = (r.breadcrumbs || []).map(function (c) {
            return '<li class="' + crumbTone(c) + '"><span class="when" title="' + esc(new Date(c.t).toISOString()) + '">' + esc(rel(c.t)) + '</span><span class="dot"></span><span class="what">' + esc(describeCrumb(c)) + '</span></li>';
        }).join('') + '<li class="bad final"><span class="when">0s</span><span class="dot"></span><span class="what">' + esc(kindLabel(r.kind) + ': ' + r.message) + '</span></li>';
        var kv = [
            ['When', P.formatDate(r.created_at) + (r.occurrences > 1 ? ' (×' + r.occurrences + ', last ' + P.timeAgo(r.last_seen_at) + ')' : '')],
            ['User', r.username || '-'], ['Source', r.source], ['Page', r.url || '-'], ['Website', r.dest_host || '-'],
            ['Upstream', (r.context && r.context.upstream) || '-'], ['Session', r.session_id ? r.session_id.slice(0, 8) + '…' : '-'],
            ['Request id', r.request_id || '-'], ['Release', r.release || '-'], ['Client', (r.client_ip || '-') + ' · ' + (r.user_agent || '-')]
        ];
        showPanel(r.ref + ' · ' + kindLabel(r.kind),
            '<p>' + sevBadge(r) + (r.resolved ? ' <span class="badge ok">Resolved ' + esc(P.timeAgo(r.resolved_at)) + '</span>' : '') + '</p>' +
            '<p><strong>' + esc(r.message) + '</strong></p>' +
            '<dl class="kv">' + kv.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; }).join('') + '</dl>' +
            '<h3>Steps before the error</h3><ol class="timeline" aria-label="Steps before the error">' + steps + '</ol>' +
            (r.stack ? '<h3>Stack trace</h3><pre class="block">' + esc(r.stack) + '</pre>' : '') +
            '<h3>Details</h3><pre class="block">' + esc(JSON.stringify(r.context, null, 2)) + '</pre>',
            '<button type="button" id="err-copy">Copy as JSON</button>' +
            (r.session_id ? '<button type="button" id="err-session">Session timeline</button>' : '') +
            (r.resolved ? '<button type="button" id="err-reopen">Reopen</button>'
                : '<button type="button" id="err-resolve-all">Resolve all like this</button><button type="button" class="primary" id="err-resolve">Mark resolved</button>'), true);
        P.$('#err-copy').addEventListener('click', function () {
            var text = JSON.stringify(r, null, 2);
            (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { P.toast('Copied. Paste it into the bug ticket.'); }, function () { P.toast('Copy is not available in this browser'); });
        });
        if (r.session_id) P.$('#err-session').addEventListener('click', function () { sessionTimeline(r.session_id); });
        var after = function (msg) { P.toast(msg); closeModal(); errorsView(); };
        if (r.resolved) {
            P.$('#err-reopen').addEventListener('click', async function () { await P.api('POST', '/api/admin/errors/' + r.id + '/reopen'); after('Reopened'); });
        } else {
            P.$('#err-resolve').addEventListener('click', async function () { await P.api('POST', '/api/admin/errors/' + r.id + '/resolve'); after('Marked resolved'); });
            P.$('#err-resolve-all').addEventListener('click', async function () {
                var x = await P.api('POST', '/api/admin/errors/group/' + r.fingerprint + '/resolve');
                after(x.resolved + ' report(s) resolved');
            });
        }
    }

    // =============================================================== server ==
    var serverHours = '24';
    async function serverView() {
        var d = await P.api('GET', '/api/admin/server?hours=' + serverHours);
        var byProc = {};
        d.series.forEach(function (m) { (byProc[m.process] = byProc[m.process] || []).push(m); });
        var procs = Object.keys(byProc).sort();
        var seriesOf = function (field) { return procs.map(function (p) { return { name: p, points: byProc[p].map(function (m) { return [m.ts, m[field]]; }) }; }); };
        var stale = function (m) { return Date.now() - m.ts > 3 * 60000; };
        var totals = {};
        d.series.forEach(function (m) {
            var k = Math.floor(m.ts / 60000);
            totals[k] = totals[k] || { t: k * 60000, req: 0, err: 0 };
            totals[k].req += m.requests || 0;
            totals[k].err += m.errors || 0;
        });
        var tl = Object.keys(totals).sort().map(function (k) { return totals[k]; });
        var latest = d.processes;
        var live = latest.filter(function (m) { return !stale(m); });
        var machine = live.length ? live[live.length - 1] : null;
        var starts = d.lifecycle.filter(function (e) { return e.type === 'process_start'; }).length;
        var crashes = d.lifecycle.filter(function (e) { return e.type === 'process_unclean_exit'; }).length;
        var stat = function (label, value, bad) { return '<div class="stat"><div class="label">' + esc(label) + '</div><div class="value' + (bad ? ' bad' : '') + '">' + esc(value) + '</div></div>'; };
        view.innerHTML = pageHead('Server', 'Health of every process, sampled each minute. Use it to explain slowness, restarts and crashes.', selectHtml('shours', 'Time range', serverHours, RANGES)) +
            '<div class="stats">' +
            stat('Processes reporting', live.length + ' / ' + latest.length, live.length < latest.length) +
            stat('Memory, all processes', Math.round(live.reduce(function (a, m) { return a + m.rss_mb; }, 0)) + ' MB') +
            stat('Machine free memory', machine ? machine.free_mem_mb + ' MB' : '-', machine && machine.free_mem_mb < 150) +
            stat('Load, 1 minute', machine ? String(machine.load1) : '-') +
            stat('Starts in range', String(starts)) +
            stat('Crashes in range', String(crashes), crashes > 0) +
            '</div>' +
            panel('Processes', table([{ label: 'Process' }, { label: 'PID', num: true }, { label: 'Up' }, { label: 'Memory', num: true }, { label: 'CPU', num: true }, { label: 'Loop lag', num: true }, { label: 'Requests/min', num: true }, { label: 'Errors', num: true }, { label: 'p95', num: true }, { label: 'Last sample' }],
                latest.map(function (m) {
                    var up = m.uptime_s >= 86400 ? Math.floor(m.uptime_s / 86400) + 'd' : m.uptime_s >= 3600 ? Math.floor(m.uptime_s / 3600) + 'h' : Math.floor(m.uptime_s / 60) + 'm';
                    return '<tr><td><span class="cell-main">' + esc(m.process) + '</span> ' + (stale(m) ? '<span class="badge warn">Not reporting</span>' : '<span class="badge ok">Up</span>') + '<div class="cell-sub mono">' + esc(m.release || '') + '</div></td>' +
                        '<td class="num">' + m.pid + '</td><td>' + up + '</td><td class="num">' + m.rss_mb + ' MB</td><td class="num">' + m.cpu_pct + '%</td>' +
                        '<td class="num' + (m.loop_lag_ms > 200 ? ' bad' : '') + '">' + (m.loop_lag_ms != null ? m.loop_lag_ms + ' ms' : '-') + '</td><td class="num">' + m.requests + '</td><td class="num' + (m.errors ? ' bad' : '') + '">' + m.errors + '</td>' +
                        '<td class="num">' + (m.p95_ms != null ? m.p95_ms + ' ms' : '-') + '</td><td>' + time(m.ts) + '</td></tr>';
                }), 'No samples yet. They arrive every minute.'), { cls: 'mt' }) +
            '<div class="grid two mt">' +
            panel('Memory per process (MB)', '<div class="panel-body">' + lineChart(seriesOf('rss_mb'), { unit: ' MB', label: 'Memory per process' }) + '</div>') +
            panel('Requests and errors per minute', '<div class="panel-body">' + lineChart([{ name: 'Requests', points: tl.map(function (x) { return [x.t, x.req]; }) }, { name: 'Errors', points: tl.map(function (x) { return [x.t, x.err]; }) }], { label: 'Requests and errors per minute' }) + '</div>') +
            panel('Response time, p95 (ms)', '<div class="panel-body">' + lineChart(seriesOf('p95_ms'), { unit: ' ms', label: 'Response time p95' }) + '</div>') +
            panel('Event-loop lag (ms), high = process blocked', '<div class="panel-body">' + lineChart(seriesOf('loop_lag_ms'), { unit: ' ms', label: 'Event-loop lag' }) + '</div>') +
            '</div>' +
            panel('Starts, stops and crashes', eventsTable(d.lifecycle, 'No lifecycle events yet'), { cls: 'mt' });
        P.$('#shours').addEventListener('change', function (e) { serverHours = e.target.value; serverView(); });
    }

    // ========================================================= activity log ==
    async function logsView() {
        var results = await Promise.all([P.api('GET', '/api/admin/usage?days=7'), P.api('GET', '/api/admin/events?limit=300')]);
        var usage = results[0];
        var events = results[1];
        view.innerHTML = pageHead('Activity log', 'Sign-ins, sessions, approvals, blocked sites, proxy changes, process restarts and admin actions.', '<a class="btn" href="/api/admin/events.csv" download>Export CSV</a>') +
            '<div class="grid main-side">' +
            panel('Events <span class="muted">(latest ' + events.length + ')</span>', eventsTable(events)) +
            panel('Usage per user, 7 days', table([{ label: 'User' }, { label: 'Requests', num: true }, { label: 'Traffic', num: true }], usage.users.map(function (u) {
                return '<tr><td>' + esc(u.username) + '</td><td class="num">' + u.requests + '</td><td class="num">' + esc(P.formatBytes(u.bytes)) + '</td></tr>';
            }), 'No usage yet')) +
            '</div>';
    }

    // ============================================================= settings ==
    async function settingsView() {
        var res = await P.api('GET', '/api/admin/settings');
        var s = res.values;
        var groups = [
            ['Portal', [
                { name: 'portal_title', label: 'Portal name', value: s.portal_title },
                { name: 'portal_notice', label: 'Notice on the Browse page', value: s.portal_notice, hint: 'Optional message shown to every user.' },
                { name: 'show_portal_button', label: 'Show a "Portal" button on proxied pages (the way back on phones)', type: 'checkbox', value: s.show_portal_button }
            ]],
            ['Accounts', [
                { name: 'registration_mode', label: 'Sign-up', type: 'select', value: s.registration_mode, options: [{ value: 'approval', label: 'Open, I approve each new account (recommended)' }, { value: 'open', label: 'Open, new accounts can browse immediately' }, { value: 'closed', label: 'Closed, only admins create accounts' }] },
                { name: 'user_proxies_enabled', label: 'Users may add their own proxies', type: 'checkbox', value: s.user_proxies_enabled },
                { name: 'max_proxies_per_user', label: 'Own proxies per user', type: 'number', value: s.max_proxies_per_user },
                { name: 'restrict_session_to_ip', label: 'Lock sessions to the network that created them (breaks Wi-Fi/mobile switching)', type: 'checkbox', value: s.restrict_session_to_ip }
            ]],
            ['Limits', [
                { name: 'rate_limit_rpm', label: 'Requests per minute per user', type: 'number', value: s.rate_limit_rpm, hint: 'One page can be 100+ requests. 0 = unlimited.' },
                { name: 'bandwidth_limit_mb_day', label: 'Traffic per user per day (MB)', type: 'number', value: s.bandwidth_limit_mb_day, hint: '0 = unlimited' },
                { name: 'max_sessions_per_user', label: 'Active sessions per user', type: 'number', value: s.max_sessions_per_user, hint: '0 = unlimited' }
            ]],
            ['Proxies and sites', [
                { name: 'upstream_fallback', label: 'When no proxy is available', type: 'select', value: s.upstream_fallback, options: [{ value: 'deny', label: 'Refuse (never use the server IP), recommended' }, { value: 'direct', label: 'Connect directly from the server IP' }] },
                { name: 'upstream_failover', label: 'Move a session to another proxy of its pool if its proxy goes offline', type: 'checkbox', value: s.upstream_failover },
                { name: 'allowlist_enabled', label: 'Only allow configured sites and the extra domains below', type: 'checkbox', value: s.allowlist_enabled },
                { name: 'allowlist_extra', label: 'Extra allowed domains', type: 'textarea', value: s.allowlist_extra, hint: 'One pattern per line or comma separated, e.g. *.example.com' },
                { name: 'allowlist_strict', label: 'Also block images and scripts from other domains (may break sites using CDNs)', type: 'checkbox', value: s.allowlist_strict }
            ]]
        ];
        var fieldHtml = function (f) {
            var id = 'set-' + f.name;
            var hint = f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '';
            if (f.type === 'checkbox') return '<label class="check"><input type="checkbox" id="' + id + '"' + (f.value ? ' checked' : '') + '> <span>' + esc(f.label) + '</span></label>' + hint;
            if (f.type === 'select') return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><select id="' + id + '">' + f.options.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>' + hint + '</div>';
            if (f.type === 'textarea') return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><textarea id="' + id + '">' + esc(f.value) + '</textarea>' + hint + '</div>';
            return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><input id="' + id + '" type="' + (f.type || 'text') + '" value="' + esc(f.value) + '">' + hint + '</div>';
        };
        view.innerHTML = pageHead('Settings', 'Changes apply within a few seconds, without a restart.', '<button type="button" class="primary" id="save-settings">Save changes</button>') +
            '<div id="settings-error" class="alert error hidden" role="alert"></div>' +
            '<div class="grid two">' + groups.map(function (g) { return panel(esc(g[0]), '<div class="panel-body">' + g[1].map(fieldHtml).join('') + '</div>'); }).join('') + '</div>';
        var all = [].concat.apply([], groups.map(function (g) { return g[1]; }));
        P.$('#save-settings').addEventListener('click', async function () {
            var patch = {};
            all.forEach(function (f) { var el = P.$('#set-' + f.name); patch[f.name] = f.type === 'checkbox' ? el.checked : el.value; });
            var done = P.busy(P.$('#save-settings'), 'Saving');
            try {
                await P.api('PUT', '/api/admin/settings', patch);
                P.showError(P.$('#settings-error'), '');
                P.toast('Settings saved');
            } catch (err) { P.showError(P.$('#settings-error'), err.message); }
            done();
        });
    }

    // =============================================================== router ==
    var views = { dashboard: dashboard, users: usersView, pools: poolsView, sessions: sessionsView, sites: sitesView, scripts: scriptsView, requests: requestsView, errors: errorsView, server: serverView, logs: logsView, settings: settingsView };
    var TITLES = { dashboard: 'Dashboard', users: 'Users', pools: 'Proxy pools', sessions: 'Sessions', sites: 'Sites', scripts: 'Scripts', requests: 'Requests', errors: 'Errors', server: 'Server', logs: 'Activity log', settings: 'Settings' };

    function show(tab) {
        if (!views[tab]) tab = 'dashboard';
        P.$all('#tabs button').forEach(function (b) {
            var active = b.getAttribute('data-tab') === tab;
            b.classList.toggle('active', active);
            if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        document.title = TITLES[tab] + ' · Admin';
        view.innerHTML = '<p class="muted">Loading…</p>';
        views[tab]().catch(function (err) { view.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; });
        if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    }
    P.$all('#tabs button').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-tab')); }); });
    P.$('#logout').addEventListener('click', function () { P.logout(false); });
    window.addEventListener('hashchange', function () { show(location.hash.slice(1) || 'dashboard'); });
    P.api('GET', '/api/admin/overview').then(function (o) {
        P.$('#release').textContent = o.release;
        setCount('#pending-count', o.pendingUsers);
        setCount('#error-count', o.openErrors);
    }).catch(function () {});
    show(location.hash.slice(1) || 'dashboard');
})();
