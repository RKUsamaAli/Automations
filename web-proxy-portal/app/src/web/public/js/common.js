/* =============================================================================
   Shared browser helpers (loaded on every page before the page script).
   Plain ES2017, no build step, works on iOS Safari 13+.

   Portal.api()        JSON calls with the CSRF header
   Portal.shell()      renders the top bar + bottom tab bar of the user app
   Portal.confirm()    accessible confirm dialog (replaces window.confirm)
   Portal.busy()       button loading state
   Portal.icon()       inline SVG icons
   ============================================================================= */
(function () {
    'use strict';

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
    async function api(method, url, body) {
        var opts = { method: method, headers: { 'X-CSRF-Token': readCookie('pp_csrf') }, credentials: 'same-origin' };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        var res = await fetch(url, opts);
        var data = null;
        try { data = await res.json(); } catch (_) { /* empty body */ }
        if (res.status === 401 && !/\/api\/auth\//.test(url)) {
            location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
            throw new Error('Not logged in');
        }
        if (!res.ok) {
            var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
            err.reason = data && data.reason;
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
            wrap.className = 'modal-backdrop';
            wrap.innerHTML = '<div class="modal small" role="alertdialog" aria-modal="true" aria-labelledby="cd-title">' +
                '<h2 id="cd-title">' + esc(opts.title || 'Are you sure?') + '</h2><p class="muted">' + esc(message) + '</p>' +
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
     * Renders the user app chrome: top bar (logo, nav, user) and the phone
     * bottom tab bar. active: 'browse' | 'proxies' | 'account'
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
            return '<a href="' + i.href + '"' + (i.id === active ? ' class="active" aria-current="page"' : '') + '>' + icon(i.icon) + '<span>' + esc(i.label) + '</span></a>';
        }).join('');
        var header = document.createElement('header');
        header.className = 'topbar';
        header.innerHTML = '<a class="logo" href="/"><span class="logo-mark">' + icon('logo', '') + '</span><span>' + esc(title) + '</span></a>' +
            '<nav class="topnav" aria-label="Main">' + links + '</nav><span class="spacer"></span>' +
            '<a class="user-chip hide-mobile" href="/account" title="Account"><span class="avatar">' + esc(info.user.username.charAt(0)) + '</span>' + esc(info.user.username) + '</a>' +
            '<button type="button" class="small" id="shell-logout" title="Sign out">' + icon('logout') + '<span class="hide-mobile">Sign out</span></button>';
        document.body.insertBefore(header, document.body.firstChild);
        var bottom = document.createElement('nav');
        bottom.className = 'bottomnav';
        bottom.setAttribute('aria-label', 'Main');
        bottom.innerHTML = links;
        document.body.appendChild(bottom);
        document.body.classList.add('has-bottomnav');
        $('#shell-logout').addEventListener('click', function () { logout(false); });
        return info;
    }

    window.Portal = {
        api: api, esc: esc, $: $, $all: $all, toast: toast, showError: showError, busy: busy,
        formatBytes: formatBytes, timeAgo: timeAgo, formatDate: formatDate, colorFor: colorFor,
        confirm: confirmDialog, setupReveal: setupReveal, icon: icon, shell: shell, loadMe: loadMe, logout: logout
    };
})();
