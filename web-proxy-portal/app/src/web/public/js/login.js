/* Login page: username/password or access code. */
(function () {
    'use strict';
    var P = window.Portal;
    var mode = 'password';
    var form = P.$('#login-form');
    var errorEl = P.$('#error');

    // Page title from portal settings
    P.api('GET', '/api/auth/me').then(function (me) {
        if (me.portal && me.portal.title) {
            document.title = 'Sign in - ' + me.portal.title;
            P.$('#title').textContent = me.portal.title;
        }
    }).catch(function () {});

    P.$all('.tabs button').forEach(function (btn) {
        btn.addEventListener('click', function () {
            mode = btn.getAttribute('data-mode');
            P.$all('.tabs button').forEach(function (b) { b.classList.toggle('active', b === btn); });
            P.$all('[data-for]').forEach(function (el) { el.classList.toggle('hidden', el.getAttribute('data-for') !== mode); });
            P.showError(errorEl, '');
            (mode === 'token' ? P.$('#token') : P.$('#username')).focus();
        });
    });

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = P.$('#submit');
        btn.disabled = true;
        P.showError(errorEl, '');
        try {
            var body = mode === 'token'
                ? { token: P.$('#token').value.trim() }
                : { username: P.$('#username').value.trim(), password: P.$('#password').value };
            await P.api('POST', '/api/auth/login', body);
            var next = new URLSearchParams(location.search).get('next') || '/';
            // Only same-site paths ("/x"), never "//evil.com" or "/\evil.com".
            location.href = /^\/(?![\/\\])/.test(next) ? next : '/';
        } catch (err) {
            P.showError(errorEl, err.message);
            btn.disabled = false;
        }
    });
})();
