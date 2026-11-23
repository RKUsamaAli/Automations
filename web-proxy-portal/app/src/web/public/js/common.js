/* =============================================================================
   Shared browser helpers (loaded on every page before the page script).
   Plain ES2017, no build step, works on iOS Safari 13+.

   Portal.api()        JSON calls with the CSRF header
   Portal.shell()      renders the top bar + bottom tab bar of the user app
   Portal.confirm()    accessible confirm dialog (replaces window.confirm)
   Portal.busy()       button loading state
   Portal.icon()       inline SVG icons
   Portal.reportError() send a browser-side error report (also automatic)
   ============================================================================= */
(function () {
    'use strict';

    // ------------------------------------------------------ error trail --
    // The last 40 things the user did on portal pages: pages, button presses
    // (by their label - never what was typed), API calls with status/time.
    // Kept in memory only; sent ONLY together with an error report.
    var crumbs = [];
    function crumb(type, label, extra) {
        var c = { t: Date.now(), type: type, label: String(label || '').slice(0, 120), url: location.pathname };
        if (extra) for (var k in extra) c[k] = extra[k];
        crumbs.push(c);
        if (crumbs.length > 40) crumbs.shift();
    }
    crumb('page', document.title || location.pathname);
    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('button, a, [role=tab], input[type=checkbox], select') : null;
        if (!el) return;
        var label = el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.id || el.tagName;
        crumb('click', label.replace(/\s+/g, ' ').trim());
    }, true);
    document.addEventListener('submit', function (e) { crumb('submit', (e.target && (e.target.id || e.target.getAttribute('aria-label'))) || 'form'); }, true);

    var lastReport = { key: '', at: 0 };
    /**
     * Sends an error report with the trail. Returns Promise<ref|null>.
     * Identical errors within 10 s are sent once.
     */
    function reportError(kind, message, details) {
        details = details || {};
        var key = kind + '|' + message;
        if (key === lastReport.key && Date.now() - lastReport.at < 10000) return Promise.resolve(lastReport.ref || null);
        lastReport = { key: key, at: Date.now(), ref: null };
        var body = {
            kind: kind, message: String(message || '').slice(0, 1000), stack: details.stack, source: details.source,
            line: details.line, column: details.column, api: details.api, requestId: details.requestId, status: details.status,
            page: location.pathname + location.hash, viewport: window.innerWidth + 'x' + window.innerHeight,
            online: navigator.onLine, crumbs: crumbs.slice()
        };
        return fetch('/api/client-errors', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': readCookie('pp_csrf'), 'X-Timezone': TZ || 'UTC', 'X-Client': clientInfo() },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (d) { lastReport.ref = d.ref; return d.ref || null; }).catch(function () { return null; });
    }
    window.addEventListener('error', function (e) {
        if (!e || !e.message) return; // resource load errors carry no message
        reportError('client_js', e.message, { stack: e.error && e.error.stack, source: e.filename, line: e.lineno, column: e.colno })
            .then(function (ref) { if (ref) toast('Something went wrong on this page. Reference: ' + ref, 6000); });
    });
    window.addEventListener('unhandledrejection', function (e) {
        var reason = e && e.reason;
        if (reason && reason.reported) return; // API errors are reported in api()
        reportError('client_promise', (reason && reason.message) || String(reason), { stack: reason && reason.stack });
    });

    // ------------------------------------------------------------ icons --
    var ICONS = {
        logo: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 0c2.5 2.7 3.8 6.1 3.8 10S14.5 19.3 12 22m0-20C9.5 4.7 8.2 8.1 8.2 12s1.3 7.3 3.8 10M2.5 9h19M2.5 15h19"/>',
        browse: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
        proxies: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
        account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
        admin: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
        logout: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
        link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
        check: '<path d="M5 12l5 5 9-10"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        sessions: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 8h18M7 21h10"/>',
        chevron: '<path d="M6 9l6 6 6-6"/>',
        signin: '<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        empty: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>'
    };
    function icon(name, cls) {
        return '<svg class="' + (cls || 'nav-icon') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
    }

    // -------------------------------------------------------------- api --
    function readCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    /** JSON API call. Rejects with an Error carrying the server's message (and .reason). */
    // ============================================================ time zone ==
    // The database stores UTC only. Every API call tells the server the
    // browser's zone (X-Timezone) so "today", per-day charts and daily limits
    // use local midnight; the page itself renders times in local time.
    var TZ = (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
    })();
    /** "UTC+05:00" for the browser's current offset. */
    function tzOffset() {
        var m = -new Date().getTimezoneOffset();
        var a = Math.abs(m);
        return 'UTC' + (m < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
    }
    /**
     * Device details sent with every API call (X-Client), stored once per
     * device on the server so logs show the real browser, OS, screen etc.
     * Nothing personal: no names, no ids, no fingerprinting beyond these basics.
     */
    function clientInfo() {
        var n = navigator, c = n.connection || {};
        var info = {
            screen: screen.width + 'x' + screen.height,
            vp: window.innerWidth + 'x' + window.innerHeight,
            dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
            lang: n.language || '',
            langs: (n.languages || []).slice(0, 4).join(','),
            tz: TZ,
            touch: (n.maxTouchPoints || 0) > 0,
            mem: n.deviceMemory || null,
            cores: n.hardwareConcurrency || null,
            net: c.effectiveType || null
        };
        try { return JSON.stringify(info); } catch (_) { return ''; }
    }

    /** Adds ?tz= to a plain link (downloads cannot send headers). */
    function withTz(url) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tz=' + encodeURIComponent(TZ); }

    // ============================================================ session ==
    /**
     * Sign-in session in the browser (tokens themselves are httpOnly cookies;
     * the page only knows their expiry times).
     *
     *  - access token (5 min): renewed silently via POST /api/auth/refresh,
     *    shortly before it expires while the user is active, or on demand when
     *    an API call answers 401 access_token_expired (the call is then retried).
     *  - identity token (24 h): when it expires, a password prompt is shown over
     *    the current page; after signing in again the page simply continues
     *    (pending API calls are retried). Nothing typed on the page is lost.
     */
    var session = { accessExpiresAt: 0, identityExpiresAt: 0, method: 'password', user: null };
    var lastActivity = Date.now();
    var refreshing = null;
    var reauthing = null;

    function updateSession(info, user) {
        if (info) {
            session.accessExpiresAt = info.accessExpiresAt || 0;
            session.identityExpiresAt = info.identityExpiresAt || 0;
            if (info.method) session.method = info.method;
        }
        if (user) session.user = user;
    }

    async function postAuth(url, body) {
        var res = await fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': readCookie('pp_csrf'), 'X-Timezone': TZ, 'X-Client': clientInfo() },
            body: JSON.stringify(body || {})
        });
        var data = null;
        try { data = await res.json(); } catch (_) { /* empty */ }
        return { status: res.status, data: data || {} };
    }

    /** One refresh at a time; resolves when a valid access token is in place. */
    function refreshAccess() {
        if (refreshing) return refreshing;
        refreshing = (async function () {
            var r = await postAuth('/api/auth/refresh');
            if (r.status === 200) { updateSession(r.data.session, r.data.user); crumb('auth', 'access token renewed'); return; }
            if (r.data.code === 'identity_expired') return reauth(r.data);
            location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
            throw new Error('Not logged in');
        })().finally(function () { refreshing = null; });
        return refreshing;
    }

    /** Shows the "sign in again" prompt; resolves after a successful sign-in. */
    function reauth(info) {
        if (reauthing) return reauthing;
        info = info || {};
        var username = info.username || (session.user && session.user.username) || '';
        var byCode = (info.method || session.method) === 'access_code';
        reauthing = new Promise(function (resolve) {
            var wrap = document.createElement('div');
            wrap.className = 'dialog-backdrop reauth';
            wrap.innerHTML = '<form class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="ra-title" aria-describedby="ra-msg" novalidate>' +
                '<h2 id="ra-title">Your session has expired</h2>' +
                '<p class="muted" id="ra-msg">For your security, sign in again to continue. This page stays as it is.</p>' +
                (byCode ? '' : '<div class="field"><label>Account</label><div class="reauth-user">' + esc(username) + '</div></div>') +
                '<div class="field"><label for="ra-secret">' + (byCode ? 'Access code' : 'Password') + '</label>' +
                '<input id="ra-secret" type="password" autocomplete="' + (byCode ? 'one-time-code' : 'current-password') + '" required></div>' +
                '<div class="alert error hidden" role="alert" id="ra-error"></div>' +
                '<div class="row end"><button type="button" class="ghost" data-signout>Sign out</button><button type="submit" class="primary" id="ra-go">Continue</button></div></form>';
            document.body.appendChild(wrap);
            var input = $('#ra-secret', wrap);
            var errBox = $('#ra-error', wrap);
            input.focus();
            $('[data-signout]', wrap).addEventListener('click', function () { logout(false); });
            $('form', wrap).addEventListener('submit', async function (e) {
                e.preventDefault();
                if (!input.value) { showError(errBox, byCode ? 'Enter your access code' : 'Enter your password'); return input.focus(); }
                var done = busy($('#ra-go', wrap), 'Signing in');
                var body = byCode ? { token: input.value } : { username: username, password: input.value };
                if (session.user) body.continueAs = session.user.id;
                var r = await postAuth('/api/auth/login', body);
                if (r.status === 200) {
                    updateSession(r.data.session, r.data.user);
                    crumb('auth', 'signed in again after the session expired');
                    wrap.remove();
                    reauthing = null;
                    resolve();
                    return;
                }
                done();
                input.value = '';
                input.focus();
                showError(errBox, r.data.error || 'Sign-in failed');
            });
        });
        return reauthing;
    }

    // Activity + timers: renew the access token in time while the user is active,
    // show the prompt when the identity token runs out.
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) {
        window.addEventListener(ev, function () { lastActivity = Date.now(); }, { passive: true, capture: true });
    });
    function sessionTick() {
        if (!session.identityExpiresAt || reauthing) return;
        var now = Date.now();
        if (now >= session.identityExpiresAt) { reauth(); return; }
        var activeRecently = now - lastActivity < 10 * 60000;
        if (activeRecently && session.accessExpiresAt - now < 60000) refreshAccess().catch(function () {});
    }
    setInterval(sessionTick, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastActivity = Date.now(); sessionTick(); } });

    async function api(method, url, body, isRetry) {
        var opts = { method: method, headers: { 'X-CSRF-Token': readCookie('pp_csrf'), 'X-Timezone': TZ, 'X-Client': clientInfo() }, credentials: 'same-origin' };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        var started = Date.now();
        var res;
        try {
            res = await fetch(url, opts);
        } catch (netErr) {
            // Network down / server unreachable: no server-side report possible.
            crumb('api', method + ' ' + url, { status: 'network-error', ms: Date.now() - started });
            reportError('network_error', 'Network request failed: ' + method + ' ' + url, { api: { method: method, url: url, status: 0 } });
            var ne = new Error('Cannot reach the server. Check your connection and try again.');
            ne.reported = true;
            throw ne;
        }
        crumb('api', method + ' ' + url, { status: res.status, ms: Date.now() - started });
        var data = null;
        try { data = await res.json(); } catch (_) { /* empty body */ }
        if (res.status === 401 && data && !isRetry) {
            // expired access token: renew silently and retry this call once
            if (data.code === 'access_token_expired') { await refreshAccess(); return api(method, url, body, true); }
            // expired identity token: ask for the password, then continue
            if (data.code === 'identity_expired') { await reauth(data); return api(method, url, body, true); }
        }
        if (res.status === 401 && !/\/api\/auth\/(login|register|password)/.test(url)) {
            location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
            throw new Error('Not logged in');
        }
        if (!res.ok) {
            var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
            err.reason = data && data.reason;
            err.detail = data && data.detail;
            err.status = res.status;
            err.reported = true;
            if (data && data.ref) {
                err.ref = data.ref; // the server already stored a report (5xx)
            } else if (res.status >= 500) {
                // 5xx without a report (e.g. nginx 502 while restarting): report from here.
                reportError('api_error', 'HTTP ' + res.status + ' on ' + method + ' ' + url, {
                    status: res.status, requestId: res.headers.get('X-Request-Id'), api: { method: method, url: url, status: res.status }
                }).then(function (ref) { if (ref) toast('Something went wrong. Reference: ' + ref, 6000); });
            }
            throw err;
        }
        return data;
    }

    // ---------------------------------------------------------- helpers --
    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function toast(message, ms) {
        var old = $('.toast');
        if (old) old.remove();
        var el = document.createElement('div');
        el.className = 'toast';
        el.setAttribute('role', 'status');
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, ms || 2800);
    }

    function showError(el, message) {
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
    }

    /** Puts a button into a loading state; returns a function that restores it. */
    function busy(button, label) {
        if (!button) return function () {};
        var html = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + esc(label || button.textContent.trim());
        return function () { button.disabled = false; button.innerHTML = html; };
    }

    function formatBytes(n) {
        n = Number(n) || 0;
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
    }
    function timeAgo(ms) {
        if (!ms) return 'never';
        var s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        return new Date(ms).toLocaleDateString();
    }
    function formatDate(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }

    /** Stable colour per string (site tiles, avatars). */
    function colorFor(text) {
        var palette = ['#2f5fe3', '#6b4ce6', '#0f8b8d', '#d9480f', '#c2255c', '#2b8a3e', '#5f3dc4', '#1971c2'];
        var h = 0;
        for (var i = 0; i < String(text).length; i++) h = (h * 31 + String(text).charCodeAt(i)) >>> 0;
        return palette[h % palette.length];
    }

    // ---------------------------------------------------------- confirm --
    /** Promise<boolean>. opts: { title, confirmLabel, danger } */
    function confirmDialog(message, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var wrap = document.createElement('div');
            wrap.className = 'dialog-backdrop';
            wrap.innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="cd-title" aria-describedby="cd-msg">' +
                '<h2 id="cd-title">' + esc(opts.title || 'Are you sure?') + '</h2><p class="muted" id="cd-msg">' + esc(message) + '</p>' +
                '<div class="row end"><button type="button" data-no>Cancel</button>' +
                '<button type="button" data-yes class="' + (opts.danger ? 'danger solid' : 'primary') + '">' + esc(opts.confirmLabel || 'Confirm') + '</button></div></div>';
            document.body.appendChild(wrap);
            var done = function (v) { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
            var onKey = function (e) { if (e.key === 'Escape') done(false); };
            document.addEventListener('keydown', onKey);
            $('[data-no]', wrap).addEventListener('click', function () { done(false); });
            $('[data-yes]', wrap).addEventListener('click', function () { done(true); });
            wrap.addEventListener('click', function (e) { if (e.target === wrap) done(false); });
            $('[data-yes]', wrap).focus();
        });
    }

    // ------------------------------------------------------------ forms --
    /** Adds Show/Hide buttons to every .input-wrap password field. */
    function setupReveal(root) {
        $all('.input-wrap', root).forEach(function (wrap) {
            var input = $('input', wrap);
            var btn = $('.reveal', wrap);
            if (!input || !btn) return;
            btn.addEventListener('click', function () {
                var show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.textContent = show ? 'Hide' : 'Show';
                btn.setAttribute('aria-pressed', String(show));
            });
        });
    }

    // ------------------------------------------------------------ shell --
    var me = null;
    async function loadMe() {
        if (!me) {
            me = await api('GET', '/api/auth/me');
            updateSession(me.session, me.user);
        }
        return me;
    }

    async function logout(everywhere) {
        var next = '/login?signedout=1';
        try {
            var res = await api('POST', '/api/auth/logout', { everywhere: !!everywhere });
            if (res && res.redirect) next = res.redirect; // clears the proxy cookie too, then comes back
        } catch (_) { /* ignore */ }
        location.href = next;
    }

    /**
     * Renders the app chrome: a slim top bar with the product name on the left
     * and, on the right, page actions (e.g. the Browse page's proxy chip), an
     * Admin button for admins and the account menu (Browse, Sessions, My
     * proxies, Account, Admin, theme, Sign out). Signed out (opts.public):
     * theme + "Sign in" instead.
     *   active: 'browse' | 'search' | 'sessions' | 'proxies' | 'account'
     *   opts.public: the page also works signed out (no redirect to sign-in)
     */
    async function shell(active, opts) {
        opts = opts || {};
        var info = await loadMe();
        if (!info.user && !opts.public) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return info; }
        var title = info.portal.title || 'Web Portal';
        document.title = ({ browse: title, search: 'Search', sessions: 'Sessions', proxies: 'My proxies', account: 'Account' }[active] || title) + (active === 'browse' ? '' : ' · ' + title);
        var skip = document.createElement('a');
        skip.className = 'skip-link';
        skip.href = '#main';
        skip.textContent = 'Skip to content';
        var header = document.createElement('header');
        header.className = 'topbar slim';
        var right;
        if (!info.user) {
            right = '<div class="top-actions"><span class="theme-slot"></span>' +
                (info.portal.registration && info.portal.registration !== 'closed' ? '<a class="btn ghost small hide-sm" href="/register">Create account</a>' : '') +
                '<a class="btn primary small" href="/login?next=' + encodeURIComponent(location.pathname + location.search) + '">' + icon('signin', 'icon') + '<span>Sign in</span></a></div>';
        } else {
            var items = [{ id: 'browse', href: '/', label: 'Search', icon: 'search' }, { id: 'sessions', href: '/sessions', label: 'Sessions', icon: 'sessions' }];
            if (info.portal.userProxies) items.push({ id: 'proxies', href: '/proxies', label: 'My proxies', icon: 'proxies' });
            items.push({ id: 'account', href: '/account', label: 'Account', icon: 'account' });
            if (info.user.role === 'admin') items.push({ id: 'admin', href: '/admin', label: 'Admin', icon: 'admin' });
            var menuItems = items.map(function (i) {
                return '<a role="menuitem" href="' + i.href + '"' + (i.id === active ? ' aria-current="page"' : '') + '>' + icon(i.icon, 'icon') + '<span>' + esc(i.label) + '</span></a>';
            }).join('');
            right = '<div class="top-actions"><span class="page-actions"></span>' +
                (info.user.role === 'admin' ? '<a class="btn ghost small top-admin" href="/admin">' + icon('admin', 'icon') + '<span>Admin</span></a>' : '') +
                '<div class="user-menu menu-wrap"><button type="button" class="menu-button" id="account-button" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu" aria-label="Account menu for ' + esc(info.user.username) + '">' +
                '<span class="avatar" aria-hidden="true">' + esc(info.user.username.charAt(0)) + '</span><span class="hide-sm">' + esc(info.user.username) + '</span>' + icon('chevron', 'icon chev') + '</button>' +
                '<div class="menu" id="account-menu" role="menu" aria-label="Account" hidden>' +
                '<div class="menu-head"><strong>' + esc(info.user.username) + '</strong><span class="muted small">' + esc(info.user.role === 'admin' ? 'Administrator' : 'Signed in') + '</span></div>' +
                menuItems + '<div class="menu-theme"><span class="muted small">Theme</span><span class="theme-slot"></span></div>' +
                '<button type="button" role="menuitem" id="shell-logout">' + icon('logout', 'icon') + '<span>Sign out</span></button></div></div></div>';
        }
        header.innerHTML = '<a class="brand" href="/"><span class="brand-mark">' + icon('logo', '') + '</span><span>' + esc(title) + '</span></a>' + right;
        document.body.insertBefore(header, document.body.firstChild);
        document.body.insertBefore(skip, header);
        var main = document.querySelector('main');
        if (main) { main.id = 'main'; main.setAttribute('tabindex', '-1'); }
        if (window.PortalTheme) $all('.theme-slot', header).forEach(function (slot) { window.PortalTheme.mount(slot); });
        if (info.user) {
            $('#shell-logout').addEventListener('click', function () { logout(false); });
            popover($('#account-button'), $('#account-menu'));
        }
        return info;
    }

    /**
     * Button + floating panel (menu or popover): click toggles, Escape and a
     * click outside close it, focus returns to the button.
     */
    function popover(button, panel, onOpen) {
        function close(focus) {
            if (panel.hidden) return;
            panel.hidden = true;
            button.setAttribute('aria-expanded', 'false');
            if (focus) button.focus();
        }
        function open() {
            panel.hidden = false;
            button.setAttribute('aria-expanded', 'true');
            if (onOpen) onOpen();
            var first = panel.querySelector('[role=menuitem], input:not([disabled]), select, button');
            if (first) first.focus();
        }
        button.addEventListener('click', function () { if (panel.hidden) open(); else close(false); });
        panel.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.stopPropagation(); close(true); }
            if (panel.getAttribute('role') === 'menu' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                var items = [].slice.call(panel.querySelectorAll('[role=menuitem]'));
                var i = items.indexOf(document.activeElement);
                items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
                e.preventDefault();
            }
        });
        document.addEventListener('pointerdown', function (e) {
            if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(false);
        });
        return { open: open, close: close };
    }

    // ============================================================ suggest ==
    /**
     * Type-ahead suggestions for an <input> (ARIA 1.2 combobox pattern).
     *
     *   Portal.suggest(input, {
     *       source: async function (q) { return [{ label: 'Users', items: [{ value, label, hint }] }]; },
     *       onPick: function (item, group) {},   // default: put item.value in the box
     *       tokens: true,                        // comma-separated lists ("a.com, b.com")
     *       openOnFocus: true                    // show options before typing
     *   });
     *
     * Keyboard: Down/Up move, Enter picks, Escape closes, Tab leaves.
     * Typing anything that is not in the list still works - suggestions
     * never block free text.
     */
    var suggestSeq = 0;
    function suggest(input, opts) {
        opts = opts || {};
        var id = 'sg' + (++suggestSeq);
        var wrap = document.createElement('div');
        wrap.className = 'suggest-wrap';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        var list = document.createElement('div');
        list.className = 'suggest hidden';
        list.id = id;
        list.setAttribute('role', 'listbox');
        list.setAttribute('aria-label', (input.getAttribute('aria-label') || input.placeholder || 'Suggestions'));
        wrap.appendChild(list);
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', id);
        input.setAttribute('autocomplete', 'off');

        var options = [];   // [{ el, item, group }]
        var active = -1;
        var reqNo = 0;
        var timer = null;

        function term() {
            if (!opts.tokens) return input.value.trim();
            var parts = input.value.split(',');
            return parts[parts.length - 1].trim();
        }
        function mark(text, q) {
            text = String(text == null ? '' : text);
            var i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
            if (i < 0) return esc(text);
            return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
        }
        function close() {
            list.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            active = -1;
        }
        function setActive(i) {
            if (active >= 0 && options[active]) options[active].el.classList.remove('active');
            active = i;
            if (i < 0 || !options[i]) { input.removeAttribute('aria-activedescendant'); return; }
            options[i].el.classList.add('active');
            options[i].el.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', options[i].el.id);
        }
        function render(groups, q) {
            if (!Array.isArray(groups)) groups = [];
            if (groups.length && !groups[0].items) groups = [{ items: groups }];
            groups = groups.filter(function (g) { return g.items && g.items.length; });
            options = [];
            active = -1;
            if (!groups.length) {
                if (q && opts.emptyText) {
                    list.innerHTML = '<div class="suggest-empty">' + esc(opts.emptyText) + '</div>';
                    list.classList.remove('hidden');
                    input.setAttribute('aria-expanded', 'true');
                } else close();
                return;
            }
            list.innerHTML = '';
            groups.forEach(function (g, gi) {
                var box = list;
                if (g.label) {
                    box = document.createElement('div');
                    box.setAttribute('role', 'group');
                    box.setAttribute('aria-labelledby', id + '-g' + gi);
                    box.innerHTML = '<div class="suggest-group" id="' + id + '-g' + gi + '">' + esc(g.label) + '</div>';
                    list.appendChild(box);
                }
                g.items.forEach(function (item) {
                    var el = document.createElement('div');
                    el.className = 'suggest-option';
                    el.id = id + '-o' + options.length;
                    el.setAttribute('role', 'option');
                    el.innerHTML = '<span class="suggest-label">' + mark(item.label, q) + '</span>' + (item.hint ? '<span class="suggest-hint">' + mark(item.hint, q) + '</span>' : '');
                    var index = options.length;
                    // mousedown, not click: keeps focus in the input
                    el.addEventListener('mousedown', function (e) { e.preventDefault(); pick(index); });
                    box.appendChild(el);
                    options.push({ el: el, item: item, group: g });
                });
            });
            list.classList.remove('hidden');
            input.setAttribute('aria-expanded', 'true');
        }
        function pick(i) {
            var o = options[i];
            if (!o) return;
            close();
            if (opts.onPick) { opts.onPick(o.item, o.group); return; }
            if (opts.tokens) {
                var parts = input.value.split(',').map(function (x) { return x.trim(); });
                parts[parts.length - 1] = o.item.value;
                input.value = parts.filter(Boolean).join(', ') + ', ';
            } else input.value = o.item.value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        function refresh() {
            var q = term();
            var my = ++reqNo;
            Promise.resolve(opts.source(q)).then(function (groups) {
                if (my !== reqNo || document.activeElement !== input) return; // stale or focus left
                render(groups, q);
            }).catch(function () { close(); });
        }
        input.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(refresh, 150);
        });
        input.addEventListener('focus', function () { if (opts.openOnFocus !== false) refresh(); });
        input.addEventListener('blur', function () { setTimeout(close, 100); });
        input.addEventListener('keydown', function (e) {
            var open = !list.classList.contains('hidden');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!open) return refresh();
                setActive(Math.min(active + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
                if (!open) return;
                e.preventDefault();
                setActive(Math.max(active - 1, 0));
            } else if (e.key === 'Enter' && open && active >= 0) {
                e.preventDefault();
                pick(active);
            } else if (e.key === 'Escape' && open) {
                e.preventDefault();
                e.stopPropagation(); // do not close the surrounding drawer
                close();
            }
        });
        return { refresh: refresh, close: close };
    }

    /** Filters a fixed option list on the client: [{ value, label, hint }]. */
    function filterOptions(items, q, limit) {
        q = String(q || '').toLowerCase();
        var starts = [], contains = [];
        items.forEach(function (it) {
            var text = (it.label + ' ' + (it.hint || '') + ' ' + it.value).toLowerCase();
            if (!q || String(it.label).toLowerCase().indexOf(q) === 0 || String(it.value).toLowerCase().indexOf(q) === 0) starts.push(it);
            else if (text.indexOf(q) !== -1) contains.push(it);
        });
        return starts.concat(contains).slice(0, limit || 8);
    }

    window.Portal = {
        popover: popover,
        api: api, esc: esc, $: $, $all: $all, toast: toast, showError: showError, busy: busy,
        formatBytes: formatBytes, timeAgo: timeAgo, formatDate: formatDate, colorFor: colorFor,
        confirm: confirmDialog, setupReveal: setupReveal, icon: icon, shell: shell, loadMe: loadMe, logout: logout,
        reportError: reportError, crumb: crumb, suggest: suggest, filterOptions: filterOptions,
        tz: TZ, tzOffset: tzOffset, withTz: withTz, updateSession: updateSession, session: session
    };
})();
