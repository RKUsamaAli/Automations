/* =============================================================================
   Admin panel. One small "view" function per tab renders into #view.
   Forms use the generic openForm() modal helper below.
   ============================================================================= */
(function () {
    'use strict';
    var P = window.Portal;
    var esc = P.esc;
    var view = P.$('#view');
    var state = { pools: [], poolTypes: [] };

    // ---------------------------------------------------------------- utils --
    // Same wording as the user's "My proxies" screen.
    function badge(status) {
        var map = { healthy: ['ok', 'Online'], slow: ['warn', 'Slow'], dead: ['bad', 'Offline'], unknown: ['', 'Not checked'] };
        var m = map[status] || ['', status];
        return '<span class="badge ' + m[0] + '" title="' + esc(status) + '">' + m[1] + '</span>';
    }
    function yesNo(v) { return v ? '<span class="badge ok">yes</span>' : '<span class="badge">no</span>'; }
    function poolName(id) {
        var p = state.pools.find(function (x) { return x.id === id; });
        return p ? p.name : '-';
    }
    function poolOptions(includeNone, noneLabel) {
        var opts = includeNone ? [{ value: '', label: noneLabel || '(none)' }] : [];
        return opts.concat(state.pools.map(function (p) { return { value: String(p.id), label: p.name + (p.is_default ? ' (default)' : '') }; }));
    }
    async function loadPools() {
        var res = await P.api('GET', '/api/admin/pools');
        state.pools = res.pools;
        state.poolTypes = res.types;
    }
    function on(selector, event, handler) {
        P.$all(selector, view).forEach(function (el) { el.addEventListener(event, function (e) { handler(el, e); }); });
    }
    async function confirmed(message, fn, opts) {
        if (!(await P.confirm(message, opts || { confirmLabel: 'Continue', danger: true }))) return;
        try { await fn(); } catch (err) { P.toast(err.message); }
    }
    function updateErrorBadge(n) {
        var el = P.$('#error-count');
        el.textContent = n;
        el.classList.toggle('hidden', !n);
    }
    function updatePendingBadge(n) {
        var el = P.$('#pending-count');
        el.textContent = n;
        el.classList.toggle('hidden', !n);
    }

    // ---------------------------------------------------------------- modal --
    var modal = P.$('#modal');
    var modalError = P.$('#modal-error');
    function closeModal() { modal.classList.add('hidden'); modal.querySelector('.modal').classList.remove('wide'); P.$('#modal-body').innerHTML = ''; }
    P.$('#modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

    /**
     * openForm({ title, fields, submitLabel, onSubmit })
     * field: { name, label, type: text|password|number|select|textarea|code|checkbox|info, value, options, hint, placeholder }
     * onSubmit(values) may return a string of HTML to show instead of closing (e.g. a generated secret).
     */
    function openForm(cfg) {
        P.$('#modal-title').textContent = cfg.title;
        P.showError(modalError, '');
        var html = cfg.fields.map(function (f) {
            var id = 'f-' + f.name;
            var val = f.value == null ? '' : f.value;
            var hint = f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '';
            if (f.type === 'info') return '<div class="field">' + f.html + '</div>';
            if (f.type === 'users') {
                return '<div class="field"><label>' + esc(f.label) + '</label><div class="user-picker" id="' + id + '">' +
                    (f.options.length ? f.options.map(function (o) {
                        return '<label class="check"><input type="checkbox" value="' + o.value + '"' + (f.value.indexOf(o.value) !== -1 ? ' checked' : '') + '> ' + esc(o.label) + '</label>';
                    }).join('') : '<span class="muted small">No users yet.</span>') + '</div>' + hint + '</div>';
            }
            if (f.type === 'checkbox') {
                return '<label class="check"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (val ? ' checked' : '') + '> ' + esc(f.label) + '</label>' + hint;
            }
            var input;
            if (f.type === 'select') {
                input = '<select id="' + id + '" name="' + f.name + '">' + f.options.map(function (o) {
                    return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(val) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
                }).join('') + '</select>';
            } else if (f.type === 'textarea' || f.type === 'code') {
                input = '<textarea id="' + id + '" name="' + f.name + '"' + (f.type === 'code' ? ' class="code" spellcheck="false"' : '') +
                    ' placeholder="' + esc(f.placeholder || '') + '">' + esc(val) + '</textarea>';
            } else {
                input = '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off" autocapitalize="none">';
            }
            return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label>' + input + hint + '</div>';
        }).join('') + '<div class="row end"><button type="button" id="modal-cancel">Cancel</button><button type="submit" class="primary" id="modal-submit">' + esc(cfg.submitLabel || 'Save') + '</button></div>';

        P.$('#modal-body').innerHTML = '<form id="modal-form" novalidate>' + html + '</form>';
        modal.classList.remove('hidden');
        P.$('#modal-cancel').addEventListener('click', closeModal);
        var first = P.$('#modal-form input, #modal-form textarea, #modal-form select');
        if (first && window.innerWidth > 700) first.focus();

        P.$('#modal-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var values = {};
            cfg.fields.forEach(function (f) {
                if (f.type === 'info') return;
                var el = P.$('#f-' + f.name);
                if (f.type === 'users') {
                    values[f.name] = P.$all('input:checked', el).map(function (i) { return Number(i.value); });
                    return;
                }
                values[f.name] = f.type === 'checkbox' ? el.checked : el.value;
            });
            var btn = P.$('#modal-submit');
            btn.disabled = true;
            P.showError(modalError, '');
            try {
                var result = await cfg.onSubmit(values);
                if (typeof result === 'string') {
                    P.$('#modal-body').innerHTML = result + '<div class="row end"><button type="button" class="primary" id="modal-done">Done</button></div>';
                    P.$('#modal-done').addEventListener('click', closeModal);
                } else closeModal();
            } catch (err) {
                P.showError(modalError, err.message);
                btn.disabled = false;
            }
        });
    }

    function secretHtml(label, secret) {
        return '<p><strong>' + esc(label) + '</strong></p><div class="secret">' + esc(secret) + '</div><p class="hint">Copy it now - it is not shown again.</p>';
    }

    // ------------------------------------------------------------ dashboard --
    async function dashboard() {
        var o = await P.api('GET', '/api/admin/overview');
        P.$('#release').textContent = o.release;
        updatePendingBadge(o.pendingUsers);
        updateErrorBadge(o.openErrors);
        // Always 14 day slots (empty days = 0) so one busy day is not one giant bar.
        var byDay = {};
        o.daily.forEach(function (d) { byDay[d.day] = d; });
        var days = [];
        for (var i = 13; i >= 0; i--) {
            var key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            days.push(byDay[key] || { day: key, bytes: 0, requests: 0 });
        }
        var max = Math.max.apply(null, days.map(function (d) { return d.bytes; }).concat([1]));
        view.innerHTML =
            '<div class="stats">' +
            stat(o.sessions.active, 'Active sessions') + stat(o.sessions.today, 'Sessions today') +
            stat(o.users, 'Users') + (o.pendingUsers ? '<div class="stat highlight"><div class="value">' + o.pendingUsers + '</div><div class="label">Awaiting approval</div></div>' : '') +
            stat(o.usableProxies + ' / ' + o.proxies, 'Usable proxies') +
            (o.openErrors ? '<a class="stat highlight" href="#errors" id="open-errors-stat"><div class="value">' + o.openErrors + '</div><div class="label">Open errors</div></a>' : '') +
            stat(P.formatBytes(o.usageToday.bytes), 'Bandwidth today') + stat(o.usageToday.requests, 'Requests today') +
            '</div>' +
            (o.proxies === 0 ? '<div class="alert error">No upstream proxies yet. Open <strong>Proxy pools</strong> and import some, or allow direct connections in Settings.</div>' : '') +
            '<section class="card"><h2>Bandwidth (14 days)</h2>' +
            '<div class="bars" id="bars"></div><div class="bars-labels">' + days.map(function (d, idx) { return '<span>' + (idx % 2 ? '' : esc(d.day.slice(5))) + '</span>'; }).join('') + '</div>' +
            '</section>' +
            '<section class="card"><h2>Recent events</h2>' + eventsTable(o.recentEvents) + '</section>';
        var bars = P.$('#bars');
        if (bars) {
            days.forEach(function (d) {
                var b = document.createElement('div');
                b.className = 'bar';
                b.style.height = Math.max(2, Math.round((d.bytes / max) * 100)) + '%'; // CSSOM is allowed by the CSP
                b.title = d.day + ': ' + P.formatBytes(d.bytes) + ', ' + d.requests + ' requests';
                bars.appendChild(b);
            });
        }
    }
    function stat(value, label) { return '<div class="stat"><div class="value">' + esc(value) + '</div><div class="label">' + esc(label) + '</div></div>'; }
    var EVENT_LABELS = {
        login: 'Signed in', logout: 'Signed out', login_failed: 'Sign-in failed', register: 'Signed up',
        password_changed: 'Password changed', session_start: 'Session started', session_end_requested: 'Session ended',
        session_refused: 'Session refused', session_failover: 'Proxy failover', sessions_expired: 'Sessions expired',
        blocked_domain: 'Blocked site', rate_limited: 'Rate limited', proxy_dead: 'Proxy offline', proxy_recovered: 'Proxy back online',
        user_proxies_added: 'Own proxies added', admin_user_created: 'User created', admin_user_updated: 'User updated',
        admin_user_deleted: 'User deleted', admin_user_approved: 'User approved', admin_pool_deleted: 'Pool deleted',
        admin_pool_access: 'Pool access changed', admin_proxies_imported: 'Proxies imported', admin_script_saved: 'Script saved',
        admin_settings_updated: 'Settings changed', admin_session_ended: 'Session ended by admin'
    };
    var EVENT_TONE = { login_failed: 'bad', blocked_domain: 'bad', proxy_dead: 'bad', rate_limited: 'warn', session_refused: 'warn', session_failover: 'warn', register: 'accent', proxy_recovered: 'ok', login: 'ok' };
    function eventLabel(type) { return EVENT_LABELS[type] || type.replace(/_/g, ' '); }
    function eventsTable(list) {
        if (!list.length) return '<p class="muted">Nothing yet.</p>';
        return '<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>User</th><th>Detail</th><th>IP</th></tr></thead><tbody>' +
            list.map(function (e) {
                return '<tr><td>' + esc(P.formatDate(e.created_at)) + '</td><td><span class="badge ' + (EVENT_TONE[e.type] || '') + '" title="' + esc(e.type) + '">' + esc(eventLabel(e.type)) + '</span></td><td>' + esc(e.username || '-') +
                    '</td><td>' + esc(e.detail || '') + '</td><td class="small">' + esc(e.ip || '') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }

    // ---------------------------------------------------------------- users --
    async function usersView() {
        await loadPools();
        var all = await P.api('GET', '/api/admin/users');
        var pending = all.filter(function (u) { return u.pending; });
        var list = all.filter(function (u) { return !u.pending; });
        updatePendingBadge(pending.length);
        view.innerHTML = (pending.length ? '<section class="card"><div class="card-title"><h2>Awaiting approval</h2><span class="count">' + pending.length + '</span></div>' +
            '<ul class="list">' + pending.map(function (u) {
                return '<li><span class="avatar">' + esc(u.username.charAt(0)) + '</span><div class="grow"><strong>' + esc(u.username) + '</strong><div class="meta">' +
                    esc((u.email ? u.email + ' · ' : '') + 'signed up ' + P.timeAgo(u.created_at)) + '</div></div>' +
                    '<div class="actions"><button type="button" class="small primary" data-approve="' + u.id + '">Approve</button><button type="button" class="small danger" data-reject="' + u.id + '">Reject</button></div></li>';
            }).join('') + '</ul></section>' : '') +
            '<section class="card"><div class="card-title"><h2>Users</h2><span class="spacer"></span><button type="button" class="primary small" id="add">Add user</button></div>' +
            '<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Sign-in</th><th>Pool</th><th>Limits</th><th>Last login</th><th></th></tr></thead><tbody>' +
            list.map(function (u) {
                return '<tr><td><strong>' + esc(u.username) + '</strong>' + (u.enabled ? '' : ' <span class="badge bad">disabled</span>') + (u.email ? '<div class="muted small">' + esc(u.email) + '</div>' : '') + (u.note ? '<div class="muted small">' + esc(u.note) + '</div>' : '') + '</td>' +
                    '<td>' + (u.role === 'admin' ? '<span class="badge accent plain">admin</span>' : 'user') + '</td><td class="small">' + [u.has_password ? 'password' : '', u.has_token ? 'access code' : ''].filter(Boolean).join(', ') + '</td>' +
                    '<td>' + esc(u.pool_id ? poolName(u.pool_id) : 'auto') + '</td>' +
                    '<td class="small">' + (u.rate_limit_rpm != null ? esc(u.rate_limit_rpm) + ' rpm' : 'default') + ' / ' + (u.bandwidth_limit_mb_day != null ? (u.bandwidth_limit_mb_day ? esc(u.bandwidth_limit_mb_day) + ' MB/day' : 'unlimited') : 'default') + '</td>' +
                    '<td class="small">' + esc(P.timeAgo(u.last_login_at)) + '</td>' +
                    '<td class="actions"><button type="button" class="small" data-edit="' + u.id + '">Edit</button> <button type="button" class="small" data-token="' + u.id + '">New code</button> <button type="button" class="small danger" data-del="' + u.id + '">Delete</button></td></tr>';
            }).join('') + '</tbody></table></div></section>';

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
                    { name: 'generateToken', label: 'Generate an access code (log in without username)', type: 'checkbox' },
                    { name: 'role', label: 'Role', type: 'select', value: 'user', options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }] },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', options: poolOptions(true, 'Automatic (site rule / default pool)') },
                    { name: 'rateLimitRpm', label: 'Requests per minute', type: 'number', placeholder: 'empty = global default' },
                    { name: 'bandwidthLimitMbDay', label: 'Bandwidth MB per day', type: 'number', placeholder: 'empty = global default, 0 = unlimited' },
                    { name: 'note', label: 'Note' }
                ],
                submitLabel: 'Create',
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
                    { name: 'enabled', label: 'Enabled', type: 'checkbox', value: !!u.enabled },
                    { name: 'role', label: 'Role', type: 'select', value: u.role, options: [{ value: 'user', label: 'User' }, { value: 'admin', label: 'Admin' }] },
                    { name: 'password', label: 'New password', type: 'password', hint: 'Leave empty to keep the current password. Changing it logs the user out.' },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', value: u.pool_id || '', options: poolOptions(true, 'Automatic (site rule / default pool)') },
                    { name: 'rateLimitRpm', label: 'Requests per minute', type: 'number', value: u.rate_limit_rpm, placeholder: 'empty = global default' },
                    { name: 'bandwidthLimitMbDay', label: 'Bandwidth MB per day', type: 'number', value: u.bandwidth_limit_mb_day, placeholder: 'empty = global default, 0 = unlimited' },
                    { name: 'note', label: 'Note', value: u.note || '' },
                    { name: 'logoutEverywhere', label: 'Log out everywhere and end all sessions', type: 'checkbox' }
                ],
                onSubmit: async function (v) {
                    var patch = { enabled: v.enabled, role: v.role, poolId: v.poolId ? Number(v.poolId) : null, rateLimitRpm: v.rateLimitRpm, bandwidthLimitMbDay: v.bandwidthLimitMbDay, note: v.note };
                    if (v.password) patch.password = v.password;
                    await P.api('PATCH', '/api/admin/users/' + u.id, patch);
                    if (v.logoutEverywhere) await P.api('POST', '/api/admin/users/' + u.id + '/logout');
                    P.toast('Saved');
                    usersView();
                }
            });
        });
        on('[data-token]', 'click', function (btn) {
            confirmed('Create a new access code? The old one stops working.', async function () {
                var res = await P.api('POST', '/api/admin/users/' + btn.getAttribute('data-token') + '/token');
                openForm({ title: 'New access code', fields: [{ type: 'info', name: 'x', html: secretHtml('Access code', res.accessToken) }], submitLabel: 'Done', onSubmit: function () {} });
                usersView();
            });
        });
        on('[data-del]', 'click', function (btn) {
            confirmed('Delete this user and end their sessions?', async function () {
                await P.api('DELETE', '/api/admin/users/' + btn.getAttribute('data-del'));
                usersView();
            });
        });
    }

    // ---------------------------------------------------------------- pools --
    async function poolsView() {
        await loadPools();
        view.innerHTML = '<section class="card"><div class="card-title"><h2>Proxy pools</h2><span class="spacer"></span><button type="button" class="primary small" id="add">Add pool</button></div>' +
            '<p class="muted small">Each browsing session is locked to ONE proxy of its pool until it ends (sticky sessions). Pool choice: user override, then the matching site, then the default pool.</p>' +
            (state.pools.length ? '<div class="table-wrap"><table><thead><tr><th>Pool</th><th>Type</th><th>Who can use it</th><th>Proxies</th><th>Usable</th><th>Sessions</th><th></th></tr></thead><tbody>' +
                state.pools.map(function (p) {
                    var who = p.owner_user_id ? '<span class="badge plain">personal · ' + esc(p.owner_username) + '</span>'
                        : p.visibility === 'all' ? '<span class="badge ok plain">all users</span>'
                        : '<span class="badge warn plain">' + p.assigned_count + ' assigned user' + (p.assigned_count === 1 ? '' : 's') + '</span>';
                    return '<tr><td><strong>' + esc(p.name) + '</strong>' + (p.is_default ? ' <span class="badge ok">default</span>' : '') + (p.country ? ' <span class="badge plain">' + esc(p.country) + '</span>' : '') + '</td>' +
                        '<td>' + esc(p.type) + '</td><td>' + who + '</td><td>' + p.proxy_count + '</td><td>' + p.usable_count + '</td><td>' + p.active_sessions + '</td>' +
                        '<td class="actions"><button type="button" class="small primary" data-open="' + p.id + '">Proxies</button>' +
                        (p.owner_user_id ? '' : ' <button type="button" class="small" data-access="' + p.id + '">Users</button> <button type="button" class="small" data-edit="' + p.id + '">Edit</button>') +
                        ' <button type="button" class="small danger" data-del="' + p.id + '">Delete</button></td></tr>';
                }).join('') + '</tbody></table></div>' : '<div class="empty"><strong>No pools yet</strong>Add a pool, then import your proxy list.</div>') +
            '</section><div id="pool-detail"></div>';

        P.$('#add').addEventListener('click', function () { poolForm(null); });
        on('[data-edit]', 'click', function (btn) { poolForm(state.pools.find(function (p) { return p.id === Number(btn.getAttribute('data-edit')); })); });
        on('[data-del]', 'click', function (btn) {
            confirmed('Delete this pool and all its proxies? Sessions using them will lose their proxy.', async function () {
                await P.api('DELETE', '/api/admin/pools/' + btn.getAttribute('data-del'));
                poolsView();
            });
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
                { name: 'type', label: 'Type', type: 'select', value: p ? p.type : 'residential', options: state.poolTypes.map(function (t) { return { value: t, label: t }; }) },
                { name: 'country', label: 'Country tag', value: p && p.country, placeholder: 'US' },
                { name: 'description', label: 'Description', value: p && p.description },
                { name: 'visibility', label: 'Who can use this pool', type: 'select', value: p ? p.visibility : 'all', options: [{ value: 'all', label: 'All users' }, { value: 'assigned', label: 'Only users I assign (use the Users button)' }] },
                { name: 'isDefault', label: 'Default pool (used when no user/site rule matches)', type: 'checkbox', value: p ? !!p.is_default : state.pools.length === 0 }
            ],
            onSubmit: async function (v) {
                if (p) await P.api('PUT', '/api/admin/pools/' + p.id, v);
                else await P.api('POST', '/api/admin/pools', v);
                poolsView();
            }
        });
    }

    /** Assign an admin pool to specific users ("allow to the users"). */
    async function poolAccess(pool) {
        var users = await P.api('GET', '/api/admin/users');
        var access = await P.api('GET', '/api/admin/pools/' + pool.id + '/access');
        openForm({
            title: 'Users of ' + pool.name,
            fields: [
                { type: 'info', name: 'i', html: '<p class="muted small">' + (pool.visibility === 'all'
                    ? 'This pool is currently visible to <strong>all users</strong>. Assignments matter once you set it to "Only users I assign" (Edit).'
                    : 'Only the users ticked below (and admins) can browse through this pool.') + '</p>' },
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
        box.innerHTML = '<section class="card"><div class="card-title"><h2>' + esc(pool.name) + '</h2><span class="spacer"></span>' +
            '<button type="button" class="small" id="check">Check now</button> <button type="button" class="small danger" id="purge">Remove dead</button> <button type="button" class="small primary" id="import">Import</button></div>' +
            (proxies.length ? '<div class="table-wrap"><table><thead><tr><th>Proxy</th><th>Status</th><th>Latency</th><th>Sessions</th><th>Checked</th><th></th></tr></thead><tbody>' +
                proxies.map(function (x) {
                    return '<tr><td class="small"><code>' + esc(x.protocol + '://' + (x.username ? x.username + ':***@' : '') + x.host + ':' + x.port) + '</code>' +
                        (x.last_error ? '<div class="muted small">' + esc(x.last_error) + '</div>' : '') + '</td>' +
                        '<td>' + (!x.enabled ? '<span class="badge">Disabled</span>' : x.status === 'unknown' && x.last_error ? '<span class="badge warn">Not responding</span>' : badge(x.status)) + '</td>' +
                        '<td>' + (x.latency_ms != null ? x.latency_ms + ' ms' : '-') + '</td><td>' + x.active_sessions + '</td>' +
                        '<td class="small">' + esc(P.timeAgo(x.last_checked_at)) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-toggle="' + x.id + '" data-enabled="' + x.enabled + '">' + (x.enabled ? 'Disable' : 'Enable') + '</button> <button type="button" class="small danger" data-remove="' + x.id + '">Remove</button></td></tr>';
                }).join('') + '</tbody></table></div>' : '<p class="muted">No proxies in this pool yet. Click Import.</p>') + '</section>';

        P.$('#import').addEventListener('click', function () {
            openForm({
                title: 'Import proxies into ' + pool.name,
                fields: [
                    { name: 'text', label: 'Proxy list (one per line)', type: 'code', placeholder: 'http://user:pass@1.2.3.4:8080\nsocks5://user:pass@1.2.3.4:1080\n1.2.3.4:8080:user:pass', hint: 'Formats: http://user:pass@ip:port, socks5://user:pass@ip:port, ip:port:user:pass (Webshare), ip:port.' },
                    { name: 'defaultProtocol', label: 'Protocol for lines without a scheme', type: 'select', value: 'http', options: [{ value: 'http', label: 'http' }, { value: 'socks5', label: 'socks5' }] }
                ],
                submitLabel: 'Import',
                onSubmit: async function (v) {
                    var r = await P.api('POST', '/api/admin/pools/' + poolId + '/import', v);
                    await loadPools();
                    poolDetail(poolId);
                    return '<p>Added <strong>' + r.added + '</strong>, skipped ' + r.skipped + ' duplicates. A health check is running in the background.</p>' +
                        (r.errors.length ? '<div class="alert error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
                }
            });
        });
        P.$('#check').addEventListener('click', async function () {
            var btn = P.$('#check');
            btn.disabled = true;
            btn.textContent = 'Checking...';
            try {
                var r = await P.api('POST', '/api/admin/pools/' + poolId + '/check');
                P.toast('Checked ' + r.checked + ': ' + (r.healthy || 0) + ' healthy, ' + (r.slow || 0) + ' slow, ' + (r.dead || 0) + ' dead');
            } catch (err) { P.toast(err.message); }
            poolDetail(poolId);
        });
        P.$('#purge').addEventListener('click', function () {
            confirmed('Remove all dead proxies from this pool?', async function () {
                var r = await P.api('DELETE', '/api/admin/pools/' + poolId + '/dead');
                P.toast('Removed ' + r.deleted);
                poolDetail(poolId);
            });
        });
        P.$all('[data-toggle]', box).forEach(function (btn) {
            btn.addEventListener('click', async function () {
                await P.api('PATCH', '/api/admin/proxies/' + btn.getAttribute('data-toggle'), { enabled: btn.getAttribute('data-enabled') !== '1' });
                poolDetail(poolId);
            });
        });
        P.$all('[data-remove]', box).forEach(function (btn) {
            btn.addEventListener('click', function () {
                confirmed('Remove this proxy?', async function () {
                    await P.api('DELETE', '/api/admin/proxies/' + btn.getAttribute('data-remove'));
                    poolDetail(poolId);
                });
            });
        });
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ---------------------------------------------------------------- sites --
    async function sitesView() {
        await loadPools();
        var list = await P.api('GET', '/api/admin/sites');
        view.innerHTML = '<section class="card"><div class="card-title"><h2>Target sites</h2><span class="spacer"></span><button type="button" class="primary small" id="add">Add site</button></div>' +
            '<p class="muted small">Sites appear as tiles on the landing page, can use their own proxy pool, and make up the domain allowlist when it is enabled in Settings.</p>' +
            (list.length ? '<div class="table-wrap"><table><thead><tr><th>Site</th><th>Domains</th><th>Pool</th><th>Enabled</th><th>Tile</th><th></th></tr></thead><tbody>' +
                list.map(function (s) {
                    return '<tr><td><strong>' + esc(s.name) + '</strong><div class="muted small">' + esc(s.start_url) + '</div></td><td class="small"><code>' + esc(s.domains) + '</code></td>' +
                        '<td>' + esc(s.pool_id ? poolName(s.pool_id) : 'default') + '</td><td>' + yesNo(s.enabled) + '</td><td>' + yesNo(s.show_on_landing) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-edit="' + s.id + '">Edit</button> <button type="button" class="small danger" data-del="' + s.id + '">Delete</button></td></tr>';
                }).join('') + '</tbody></table></div>' : '<p class="muted">No sites yet.</p>') + '</section>';

        function form(s) {
            openForm({
                title: s ? 'Edit site' : 'Add site',
                fields: [
                    { name: 'name', label: 'Name', value: s && s.name, placeholder: 'Example' },
                    { name: 'startUrl', label: 'Start URL', value: s && s.start_url, placeholder: 'https://www.example.com/' },
                    { name: 'domains', label: 'Domain patterns', value: s ? s.domains : '', placeholder: '*.example.com, examplecdn.net', hint: 'Comma separated. *.example.com covers example.com and all its subdomains. Include the CDNs/login domains the site uses.' },
                    { name: 'poolId', label: 'Proxy pool', type: 'select', value: s ? s.pool_id || '' : '', options: poolOptions(true, 'Default pool') },
                    { name: 'sortOrder', label: 'Sort order', type: 'number', value: s ? s.sort_order : 0 },
                    { name: 'enabled', label: 'Enabled', type: 'checkbox', value: s ? !!s.enabled : true },
                    { name: 'showOnLanding', label: 'Show tile on landing page', type: 'checkbox', value: s ? !!s.show_on_landing : true }
                ],
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
            confirmed('Delete this site?', async function () {
                await P.api('DELETE', '/api/admin/sites/' + btn.getAttribute('data-del'));
                sitesView();
            });
        });
    }

    // -------------------------------------------------------------- scripts --
    async function scriptsView() {
        var res = await P.api('GET', '/api/admin/scripts');
        var list = res.scripts;
        view.innerHTML = '<section class="card"><div class="card-title"><h2>Injected scripts</h2><span class="spacer"></span><button type="button" class="primary small" id="add">Add script</button></div>' +
            '<p class="muted small">Scripts are added to every matching proxied page, lowest load order first. Inside a script, <code>window.__portal.page.url</code> / <code>.host</code> give the real site address (<code>location</code> shows the proxy URL). Changes apply within a few seconds.</p>' +
            (list.length ? '<div class="table-wrap"><table><thead><tr><th>Order</th><th>Script</th><th>Domains</th><th>Runs at</th><th>Enabled</th><th></th></tr></thead><tbody>' +
                list.map(function (s) {
                    return '<tr><td>' + s.load_order + '</td><td><strong>' + esc(s.name) + '</strong><div class="muted small">' + esc(P.formatBytes(s.code.length)) + ', updated ' + esc(P.timeAgo(s.updated_at)) + '</div></td>' +
                        '<td class="small"><code>' + esc(s.domains) + '</code></td><td class="small">' + esc(s.run_at) + '</td><td>' + yesNo(s.enabled) + '</td>' +
                        '<td class="actions"><button type="button" class="small" data-edit="' + s.id + '">Edit</button> <button type="button" class="small danger" data-del="' + s.id + '">Delete</button></td></tr>';
                }).join('') + '</tbody></table></div>' : '<p class="muted">No scripts yet. Example scripts can be added with <code>sudo portal-cli seed-examples</code>.</p>') + '</section>';

        function form(s) {
            openForm({
                title: s ? 'Edit script' : 'Add script',
                fields: [
                    { name: 'name', label: 'Name', value: s && s.name },
                    { name: 'domains', label: 'Run on domains', value: s ? s.domains : '*', hint: 'Comma separated patterns. * = every site.' },
                    { name: 'runAt', label: 'Run at', type: 'select', value: s ? s.run_at : 'document-end', options: res.runAt.map(function (r) { return { value: r, label: r }; }), hint: 'document-start: immediately. document-end: when the HTML is parsed (recommended). document-idle: right after that.' },
                    { name: 'loadOrder', label: 'Load order', type: 'number', value: s ? s.load_order : 100 },
                    { name: 'enabled', label: 'Enabled', type: 'checkbox', value: s ? !!s.enabled : true },
                    { name: 'code', label: 'JavaScript', type: 'code', value: s ? s.code : '// Example: add a banner\nvar bar = document.createElement("div");\nbar.textContent = "Viewing " + window.__portal.page.host;\ndocument.body.prepend(bar);\n' }
                ],
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
            confirmed('Delete this script?', async function () {
                await P.api('DELETE', '/api/admin/scripts/' + btn.getAttribute('data-del'));
                scriptsView();
            });
        });
    }

    // ------------------------------------------------------------- sessions --
    async function sessionsView() {
        var list = await P.api('GET', '/api/admin/sessions');
        view.innerHTML = '<section class="card"><div class="card-title"><h2>Active sessions (' + list.length + ')</h2><span class="spacer"></span><button type="button" class="small" id="reload">Refresh</button></div>' +
            (list.length ? '<div class="table-wrap"><table><thead><tr><th>User</th><th>Start URL</th><th>Upstream</th><th>Usage</th><th>Last seen</th><th></th></tr></thead><tbody>' +
                list.map(function (s) {
                    return '<tr><td>' + esc(s.username) + '<div class="muted small">' + esc(s.client_ip || '') + '</div></td><td class="small">' + esc((s.start_url || '').slice(0, 80)) + '</td>' +
                        '<td class="small">' + esc(s.pool_name || '-') + '<div class="muted">' + esc(s.proxy_host ? s.proxy_host + ':' + s.proxy_port : 'direct') + '</div></td>' +
                        '<td class="small">' + esc(P.formatBytes(s.bytes)) + '<div class="muted">' + s.requests + ' req</div></td><td class="small">' + esc(P.timeAgo(s.last_seen_at)) + '</td>' +
                        '<td class="actions"><button type="button" class="small danger" data-end="' + esc(s.id) + '">End</button></td></tr>';
                }).join('') + '</tbody></table></div>' : '<p class="muted">No active sessions.</p>') + '</section>';
        P.$('#reload').addEventListener('click', sessionsView);
        on('[data-end]', 'click', function (btn) {
            confirmed('End this session?', async function () {
                await P.api('POST', '/api/admin/sessions/' + encodeURIComponent(btn.getAttribute('data-end')) + '/end');
                P.toast('Session will end within 30 seconds');
                sessionsView();
            });
        });
    }

    // ----------------------------------------------------------------- logs --
    async function logsView() {
        var usage = await P.api('GET', '/api/admin/usage?days=7');
        var events = await P.api('GET', '/api/admin/events?limit=200');
        view.innerHTML = '<div class="toolbar"><span class="spacer"></span><a class="btn small" href="/api/admin/events.csv" download>Export activity (CSV)</a></div>' +
            '<section class="card"><h2>Usage per user (7 days)</h2><div class="table-wrap"><table><thead><tr><th>User</th><th>Requests</th><th>Bandwidth</th></tr></thead><tbody>' +
            usage.users.map(function (u) { return '<tr><td>' + esc(u.username) + '</td><td>' + u.requests + '</td><td>' + esc(P.formatBytes(u.bytes)) + '</td></tr>'; }).join('') +
            '</tbody></table></div></section><section class="card"><h2>Event log</h2>' + eventsTable(events) + '</section>';
    }

    // ------------------------------------------------------------- settings --
    async function settingsView() {
        var res = await P.api('GET', '/api/admin/settings');
        var s = res.values;
        view.innerHTML = '<section class="card"><h2>Settings</h2><div id="settings-form"></div></section>';
        var fields = [
            { name: 'portal_title', label: 'Portal title', value: s.portal_title },
            { name: 'registration_mode', label: 'Sign-up', type: 'select', value: s.registration_mode, options: [{ value: 'approval', label: 'Open, but I approve each new account (recommended)' }, { value: 'open', label: 'Open - new accounts can browse immediately' }, { value: 'closed', label: 'Closed - only admins create accounts' }] },
            { name: 'user_proxies_enabled', label: 'Users may add their own proxies ("My proxies")', type: 'checkbox', value: s.user_proxies_enabled },
            { name: 'max_proxies_per_user', label: 'Max own proxies per user', type: 'number', value: s.max_proxies_per_user },
            { name: 'show_portal_button', label: 'Show a small "Portal" button on proxied pages (way back on iPhone)', type: 'checkbox', value: s.show_portal_button },
            { name: 'portal_notice', label: 'Landing page notice', value: s.portal_notice, hint: 'Optional message shown to all users.' },
            { name: 'allowlist_enabled', label: 'Domain allowlist: only allow configured sites + extra domains', type: 'checkbox', value: s.allowlist_enabled },
            { name: 'allowlist_extra', label: 'Extra allowed domains', type: 'textarea', value: s.allowlist_extra, hint: 'One pattern per line or comma separated, e.g. *.example.com' },
            { name: 'allowlist_strict', label: 'Strict allowlist: also block images/scripts from other domains (may break sites using CDNs)', type: 'checkbox', value: s.allowlist_strict },
            { name: 'rate_limit_rpm', label: 'Default requests per minute per user', type: 'number', value: s.rate_limit_rpm, hint: 'One page load can be 100+ requests. 0 = unlimited.' },
            { name: 'bandwidth_limit_mb_day', label: 'Default bandwidth MB per user per day', type: 'number', value: s.bandwidth_limit_mb_day, hint: '0 = unlimited' },
            { name: 'max_sessions_per_user', label: 'Max active sessions per user', type: 'number', value: s.max_sessions_per_user, hint: '0 = unlimited' },
            { name: 'upstream_fallback', label: 'When no healthy upstream proxy is available', type: 'select', value: s.upstream_fallback, options: [{ value: 'deny', label: 'Refuse (never use the server IP) - recommended' }, { value: 'direct', label: 'Connect directly from the server IP' }] },
            { name: 'upstream_failover', label: 'Move a session to another proxy in its pool if its proxy dies', type: 'checkbox', value: s.upstream_failover },
            { name: 'restrict_session_to_ip', label: 'Lock sessions to the IP that created them (breaks Wi-Fi/4G switching)', type: 'checkbox', value: s.restrict_session_to_ip }
        ];
        // Reuse the modal form renderer, but inline.
        var holder = P.$('#settings-form');
        holder.innerHTML = fields.map(function (f) {
            var id = 'set-' + f.name;
            var hint = f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '';
            if (f.type === 'checkbox') return '<label class="check"><input type="checkbox" id="' + id + '"' + (f.value ? ' checked' : '') + '> ' + esc(f.label) + '</label>' + hint;
            if (f.type === 'select') return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><select id="' + id + '">' + f.options.map(function (o) { return '<option value="' + esc(o.value) + '"' + (o.value === f.value ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>' + hint + '</div>';
            if (f.type === 'textarea') return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><textarea id="' + id + '">' + esc(f.value) + '</textarea>' + hint + '</div>';
            return '<div class="field"><label for="' + id + '">' + esc(f.label) + '</label><input id="' + id + '" type="' + (f.type || 'text') + '" value="' + esc(f.value) + '">' + hint + '</div>';
        }).join('') + '<div id="settings-error" class="alert error hidden"></div><div class="row end"><button type="button" class="primary" id="save-settings">Save settings</button></div>';

        P.$('#save-settings').addEventListener('click', async function () {
            var patch = {};
            fields.forEach(function (f) {
                var el = P.$('#set-' + f.name);
                patch[f.name] = f.type === 'checkbox' ? el.checked : el.value;
            });
            try {
                await P.api('PUT', '/api/admin/settings', patch);
                P.showError(P.$('#settings-error'), '');
                P.toast('Settings saved (active within a few seconds)');
            } catch (err) { P.showError(P.$('#settings-error'), err.message); }
        });
    }

    // --------------------------------------------------------------- errors --
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
        updateErrorBadge(res.open);
        var list = res.reports;
        view.innerHTML =
            '<div class="toolbar"><div class="segmented" role="tablist">' + ['open', 'resolved', 'all'].map(function (st) {
                return '<button type="button" data-filter="' + st + '" class="' + (errorFilter.status === st ? 'active' : '') + '">' + st.charAt(0).toUpperCase() + st.slice(1) + '</button>';
            }).join('') + '</div>' +
            '<input type="search" id="error-q" placeholder="Search reference, message, site, user" value="' + esc(errorFilter.q) + '" aria-label="Search errors">' +
            '<a class="btn small" href="/api/admin/errors.jsonl?days=30" download>Export (JSON Lines)</a></div>' +
            '<section class="card"><div class="card-title"><h2>Error reports</h2><span class="muted small">' + list.length + ' shown</span></div>' +
            '<p class="card-sub">Only failures are recorded. Each report includes the steps the user took before it happened, so it can be reproduced. Users see the reference (e.g. E-7K2P9Q) on the error page.</p>' +
            (list.length ? '<div class="table-wrap"><table><thead><tr><th>Reference</th><th>What</th><th>Where</th><th>User</th><th>Message</th><th>Seen</th><th></th></tr></thead><tbody>' +
                list.map(function (r) {
                    var where = r.dest_host || (r.url || '').split('?')[0] || '-';
                    return '<tr><td><code>' + esc(r.ref) + '</code>' + (r.resolved ? ' <span class="badge ok plain">resolved</span>' : '') + '</td>' +
                        '<td>' + sevBadge(r) + '<div class="muted small">' + esc(r.source) + '</div></td>' +
                        '<td class="small">' + esc(where.slice(0, 60)) + '</td><td>' + esc(r.username || '-') + '</td>' +
                        '<td class="small msg-cell">' + esc(r.message.slice(0, 160)) + '</td>' +
                        '<td class="small">' + esc(P.timeAgo(r.last_seen_at)) + (r.occurrences > 1 ? '<div class="muted">×' + r.occurrences + '</div>' : '') +
                        (r.group_count > 1 ? '<div class="muted">' + r.group_count + ' similar</div>' : '') + '</td>' +
                        '<td class="actions"><button type="button" class="small primary" data-view="' + esc(r.ref) + '">View</button></td></tr>';
                }).join('') + '</tbody></table></div>'
                : '<div class="empty"><strong>' + (errorFilter.status === 'open' ? 'No open errors' : 'Nothing found') + '</strong>Errors appear here the moment a user hits one.</div>') +
            '</section>';
        P.$all('[data-filter]', view).forEach(function (b) { b.addEventListener('click', function () { errorFilter.status = b.getAttribute('data-filter'); errorsView(); }); });
        var q = P.$('#error-q');
        var timer;
        q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { errorFilter.q = q.value.trim(); errorsView().then(function () { var n = P.$('#error-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 350); });
        on('[data-view]', 'click', function (btn) { showErrorReport(btn.getAttribute('data-view')); });
    }

    function describeCrumb(c) {
        var st = c.status != null && c.status !== '' ? ' → ' + c.status : '';
        var ms = c.ms != null ? ' (' + c.ms + ' ms)' : '';
        switch (c.type) {
            case 'event': return eventLabel(c.event) + (c.detail ? ': ' + c.detail : '');
            case 'page': return 'Opened ' + (c.url || '') + st + ms + (c.error ? ' [' + c.error + ']' : '');
            case 'resource': return 'Loaded ' + (c.url || '') + st + ms;
            case 'api': return 'Portal API ' + (c.method || '') + ' ' + (c.url || '') + st + ms;
            case 'browser:click': return 'Pressed “' + (c.label || '') + '”' + (c.url ? ' on ' + c.url : '');
            case 'browser:submit': return 'Submitted form ' + (c.label || '') + (c.url ? ' on ' + c.url : '');
            case 'browser:page': return 'Viewed page ' + (c.url || '') + (c.label ? ' (' + c.label + ')' : '');
            case 'browser:api': return 'Browser called ' + (c.label || '') + st + ms;
            default: return (c.type || 'step') + ' ' + (c.label || c.url || '') + st;
        }
    }
    function crumbTone(c) {
        var s = c.status;
        if (s === 'failed' || s === 'aborted' || s === 'network-error' || (typeof s === 'number' && s >= 400) || c.event === 'login_failed') return 'bad';
        return '';
    }

    async function showErrorReport(ref) {
        var r = await P.api('GET', '/api/admin/errors/' + encodeURIComponent(ref));
        var t0 = r.created_at;
        var rel = function (t) { var d = Math.round((t - t0) / 1000); return d === 0 ? '0s' : (d > 0 ? '+' : '−') + Math.abs(d) + 's'; };
        var steps = (r.breadcrumbs || []).map(function (c) {
            return '<li class="' + crumbTone(c) + '"><span class="when" title="' + esc(new Date(c.t).toISOString()) + '">' + esc(rel(c.t)) + '</span><span class="what">' + esc(describeCrumb(c)) + '</span></li>';
        }).join('') + '<li class="bad final"><span class="when">0s</span><span class="what">' + esc(kindLabel(r.kind) + ': ' + r.message) + '</span></li>';
        var kv = [
            ['Reference', r.ref], ['When', P.formatDate(r.created_at) + (r.occurrences > 1 ? ' (×' + r.occurrences + ', last ' + P.timeAgo(r.last_seen_at) + ')' : '')],
            ['User', r.username || '-'], ['Source', r.source], ['Page / URL', r.url || '-'], ['Website', r.dest_host || '-'],
            ['Upstream', (r.context && r.context.upstream) || '-'], ['Browsing session', r.session_id ? r.session_id.slice(0, 8) + '…' : '-'],
            ['Request id', r.request_id || '-'], ['Release', r.release || '-'], ['Client', (r.client_ip || '-') + ' · ' + (r.user_agent || '-')]
        ];
        P.$('#modal-title').textContent = r.ref + ' · ' + kindLabel(r.kind);
        P.showError(P.$('#modal-error'), '');
        P.$('#modal').querySelector('.modal').classList.add('wide');
        P.$('#modal-body').innerHTML =
            '<p>' + sevBadge(r) + (r.resolved ? ' <span class="badge ok">resolved ' + esc(P.timeAgo(r.resolved_at)) + '</span>' : '') + '</p>' +
            '<p><strong>' + esc(r.message) + '</strong></p>' +
            '<dl class="kv">' + kv.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + esc(p[1]) + '</dd>'; }).join('') + '</dl>' +
            '<h3>Steps before the error</h3><ol class="timeline" aria-label="Steps before the error">' + steps + '</ol>' +
            (r.stack ? '<h3>Stack trace</h3><pre class="block">' + esc(r.stack) + '</pre>' : '') +
            '<h3>Details</h3><pre class="block">' + esc(JSON.stringify(r.context, null, 2)) + '</pre>' +
            '<div class="row end"><button type="button" id="err-copy">Copy as JSON</button>' +
            (r.resolved ? '<button type="button" id="err-reopen">Reopen</button>'
                : '<button type="button" id="err-resolve-all">Resolve all like this</button><button type="button" class="primary" id="err-resolve">Mark resolved</button>') + '</div>';
        P.$('#modal').classList.remove('hidden');
        P.$('#err-copy').addEventListener('click', function () {
            var text = JSON.stringify(r, null, 2);
            (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { P.toast('Copied - paste it into the bug ticket'); }, function () { P.toast('Copy not available in this browser'); });
        });
        var after = function (msg) { P.toast(msg); P.$('#modal').classList.add('hidden'); P.$('#modal').querySelector('.modal').classList.remove('wide'); errorsView(); };
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

    // --------------------------------------------------------------- router --
    var views = { dashboard: dashboard, users: usersView, pools: poolsView, sites: sitesView, scripts: scriptsView, sessions: sessionsView, errors: errorsView, logs: logsView, settings: settingsView };

    function show(tab) {
        if (!views[tab]) tab = 'dashboard';
        P.$all('#tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === tab); });
        view.innerHTML = '<p class="muted">Loading...</p>';
        views[tab]().catch(function (err) { view.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; });
        if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
    }
    P.$all('#tabs button').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-tab')); }); });
    P.$('#logout').addEventListener('click', function () { P.logout(false); });
    window.addEventListener('hashchange', function () { show(location.hash.slice(1) || 'dashboard'); });
    show(location.hash.slice(1) || 'dashboard');
})();
