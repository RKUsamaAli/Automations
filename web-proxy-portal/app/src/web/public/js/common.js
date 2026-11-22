/* =============================================================================
   Shared browser helpers (loaded on every portal page before the page script).
   Plain ES2017, no build step, works on iOS Safari 13+.
   ============================================================================= */
(function () {
    'use strict';

    function readCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
    }

    /**
     * JSON API call with the CSRF header the server expects.
     *   api('GET', '/api/portal/sites')
     *   api('POST', '/api/portal/browse', { url: 'example.com' })
     * Rejects with an Error carrying the server's message.
     */
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
            location.href = '/login?next=' + encodeURIComponent(location.pathname);
            throw new Error('Not logged in');
        }
        if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
        return data;
    }

    /** Escapes text for safe insertion into innerHTML. */
    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function toast(message, ms) {
        var el = document.createElement('div');
        el.className = 'toast';
        el.textContent = message;
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, ms || 2600);
    }

    function showError(el, message) {
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
    }

    function formatBytes(n) {
        n = Number(n) || 0;
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
    }

    function timeAgo(ms) {
        if (!ms) return '-';
        var s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + ' min ago';
        if (s < 86400) return Math.floor(s / 3600) + ' h ago';
        return new Date(ms).toLocaleDateString();
    }

    function formatDate(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }

    async function logout() {
        try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
        location.href = '/login';
    }

    window.Portal = { api: api, esc: esc, $: $, $all: $all, toast: toast, showError: showError, formatBytes: formatBytes, timeAgo: timeAgo, formatDate: formatDate, logout: logout };
})();
