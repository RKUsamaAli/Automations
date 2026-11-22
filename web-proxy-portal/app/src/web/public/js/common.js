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

    async function api(method, url, body) {
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
        if (res.status === 401 && !/\/api\/auth\//.test(url)) {
            location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
            throw new Error('Not logged in');
        }
        if (!res.ok) {
            var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
            err.reason = data && data.reason;
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
        if (!me) me = await api('GET', '/api/auth/me');
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
     * Renders the user app chrome: top bar (product, sections, user, sign out)
     * and, on phones, a bottom tab bar. active: 'browse' | 'proxies' | 'account'
     */
    async function shell(active) {
        var info = await loadMe();
        if (!info.user) { location.href = '/login'; return info; }
        var title = info.portal.title || 'Web Portal';
        document.title = ({ browse: 'Browse', proxies: 'My proxies', account: 'Account' }[active] || title) + ' · ' + title;
        var items = [{ id: 'browse', href: '/', label: 'Browse', icon: 'browse' }];
        if (info.portal.userProxies) items.push({ id: 'proxies', href: '/proxies', label: 'My proxies', icon: 'proxies' });
        items.push({ id: 'account', href: '/account', label: 'Account', icon: 'account' });
        if (info.user.role === 'admin') items.push({ id: 'admin', href: '/admin', label: 'Admin', icon: 'admin' });
        var links = items.map(function (i) {
            return '<a href="' + i.href + '"' + (i.id === active ? ' class="active" aria-current="page"' : '') + '>' + icon(i.icon, 'icon') + '<span>' + esc(i.label) + '</span></a>';
        }).join('');
        var skip = document.createElement('a');
        skip.className = 'skip-link';
        skip.href = '#main';
        skip.textContent = 'Skip to content';
        var header = document.createElement('header');
        header.className = 'topbar';
        header.innerHTML = '<a class="brand" href="/"><span class="brand-mark">' + icon('logo', '') + '</span><span>' + esc(title) + '</span></a>' +
            '<nav class="topnav" aria-label="Main">' + links + '</nav>' +
            '<div class="user-menu"><span class="avatar" aria-hidden="true">' + esc(info.user.username.charAt(0)) + '</span>' +
            '<span class="hide-sm">' + esc(info.user.username) + '</span>' +
            '<button type="button" class="ghost small" id="shell-logout">' + icon('logout', 'icon') + '<span>Sign out</span></button></div>';
        document.body.insertBefore(header, document.body.firstChild);
        document.body.insertBefore(skip, header);
        var main = document.querySelector('main');
        if (main) { main.id = 'main'; main.setAttribute('tabindex', '-1'); }
        var bottom = document.createElement('nav');
        bottom.className = 'bottomnav';
        bottom.setAttribute('aria-label', 'Main');
        bottom.innerHTML = links;
        document.body.appendChild(bottom);
        document.body.classList.add('has-bottomnav');
        $('#shell-logout').addEventListener('click', function () { logout(false); });
        return info;
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
        api: api, esc: esc, $: $, $all: $all, toast: toast, showError: showError, busy: busy,
        formatBytes: formatBytes, timeAgo: timeAgo, formatDate: formatDate, colorFor: colorFor,
        confirm: confirmDialog, setupReveal: setupReveal, icon: icon, shell: shell, loadMe: loadMe, logout: logout,
        reportError: reportError, crumb: crumb, suggest: suggest, filterOptions: filterOptions,
        tz: TZ, tzOffset: tzOffset, withTz: withTz
    };
})();
