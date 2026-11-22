/*
 * Theme: System (follow the device) / Light / Dark.
 *
 * Loaded in <head> BEFORE the page paints, so a dark-mode user never sees a
 * white flash. The choice is kept per browser (localStorage) and applied as
 * <html data-theme="light|dark">; System = no attribute (CSS media query).
 *
 *   PortalTheme.mount(container)  -> renders the 3-button switch into container
 */
(function () {
    'use strict';
    var KEY = 'portal.theme';
    var root = document.documentElement;
    function get() {
        try { return localStorage.getItem(KEY) || 'system'; } catch (_) { return 'system'; }
    }
    function apply(mode) {
        if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
        else root.removeAttribute('data-theme');
        // keep the browser UI (address bar on phones) in the same colour
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--bg').trim() || '#f6f7f9');
    }
    function set(mode) {
        try { localStorage.setItem(KEY, mode); } catch (_) { /* private mode: this page only */ }
        apply(mode);
        Array.prototype.forEach.call(document.querySelectorAll('.theme-switch button'), function (b) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode));
        });
    }
    apply(get());

    var ICONS = {
        system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
        light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
        dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
    };
    var LABELS = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

    function mount(container) {
        if (!container) return;
        var current = get();
        var box = document.createElement('div');
        box.className = 'theme-switch';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'Theme');
        box.innerHTML = ['system', 'light', 'dark'].map(function (m) {
            return '<button type="button" data-mode="' + m + '" aria-pressed="' + (m === current) + '" aria-label="' + LABELS[m] + '" title="' + LABELS[m] + '">' + ICONS[m] + '</button>';
        }).join('');
        box.addEventListener('click', function (e) {
            var b = e.target.closest('button[data-mode]');
            if (b) set(b.getAttribute('data-mode'));
        });
        container.appendChild(box);
    }

    // Follow live device changes while on "System".
    if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () { if (get() === 'system') apply('system'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    window.PortalTheme = { get: get, set: set, mount: mount };
})();
