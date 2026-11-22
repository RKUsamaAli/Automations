/* =============================================================================
   Sign-in (login.html) and sign-up (register.html) pages.
   ============================================================================= */
(function () {
    'use strict';
    // Theme switch in the corner of the sign-in / sign-up pages.
    if (window.PortalTheme) {
        var corner = document.createElement('div');
        corner.className = 'auth-theme';
        document.body.appendChild(corner);
        window.PortalTheme.mount(corner);
    }
    var P = window.Portal;
    var params = new URLSearchParams(location.search);
    P.setupReveal(document);

    // Branding + whether sign-up is offered.
    var mePromise = P.loadMe().catch(function () { return { portal: {} }; });
    mePromise.then(function (me) {
        var title = me.portal && me.portal.title;
        if (title) {
            P.$all('[data-portal-title]').forEach(function (el) { el.textContent = title; });
            document.title = document.title + ' · ' + title;
        }
        var reg = me.portal && me.portal.registration;
        var link = P.$('#register-link');
        if (link && reg && reg !== 'closed') link.classList.remove('hidden');
        if (P.$('#register-form')) setupRegister(reg);
    });

    // ------------------------------------------------------------- login --
    var loginForm = P.$('#login-form');
    if (loginForm) {
        var mode = 'password';
        var errorEl = P.$('#error');
        var notice = P.$('#notice');
        if (params.get('signedout')) P.showError(notice, 'You have been signed out.');
        if (params.get('expired')) P.showError(notice, 'Your session expired. Sign in again to continue.');
        if (params.get('registered')) P.showError(notice, 'Account created. You can sign in now.');

        P.$all('.tabs button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                mode = btn.getAttribute('data-mode');
                P.$all('.tabs button').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                    b.setAttribute('aria-selected', String(b === btn));
                });
                P.$all('[data-for]').forEach(function (el) { el.classList.toggle('hidden', el.getAttribute('data-for') !== mode); });
                P.showError(errorEl, '');
                (mode === 'token' ? P.$('#token') : P.$('#username')).focus();
            });
        });

        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            P.showError(errorEl, '');
            P.showError(notice, '');
            var body = mode === 'token'
                ? { token: P.$('#token').value.trim() }
                : { username: P.$('#username').value.trim(), password: P.$('#password').value };
            if (mode === 'token' ? !body.token : (!body.username || !body.password)) {
                return P.showError(errorEl, mode === 'token' ? 'Enter your access code.' : 'Enter your username and password.');
            }
            var done = P.busy(P.$('#submit'), 'Signing in');
            try {
                await P.api('POST', '/api/auth/login', body);
                var next = params.get('next') || '/';
                // Only same-site paths ("/x"), never "//evil.com" or "/\evil.com".
                location.href = /^\/(?![\/\\])/.test(next) ? next : '/';
            } catch (err) {
                errorEl.className = 'alert ' + (err.reason === 'pending' ? 'warn' : 'error');
                P.showError(errorEl, err.message);
                done();
            }
        });
    }

    // ---------------------------------------------------------- register --
    function setupRegister(regMode) {
        var form = P.$('#register-form');
        var errorEl = P.$('#error');
        if (regMode === 'closed') {
            P.$('#closed').classList.remove('hidden');
            form.classList.add('hidden');
            return;
        }
        if (regMode === 'approval') P.$('[data-register-subtitle]').textContent = 'An administrator approves new accounts.';

        var pw = P.$('#password');
        var confirmInput = P.$('#confirm');
        var bar = P.$('#strength-bar');
        var text = P.$('#strength-text');
        pw.addEventListener('input', function () {
            var v = pw.value;
            var score = (v.length >= 8) + (v.length >= 12) + /[A-Z]/.test(v) + /[0-9]/.test(v) + /[^A-Za-z0-9]/.test(v);
            var levels = [['', '0%', 'var(--danger)'], ['Weak', '25%', 'var(--danger)'], ['Fair', '50%', 'var(--warn)'], ['Good', '75%', 'var(--ok)'], ['Strong', '100%', 'var(--ok)'], ['Strong', '100%', 'var(--ok)']];
            var l = v ? levels[Math.max(1, score)] : levels[0];
            bar.style.width = l[1];
            bar.style.background = l[2];
            text.textContent = l[0] ? 'Strength: ' + l[0] : '';
        });
        var checkMatch = function () {
            var mismatch = confirmInput.value && confirmInput.value !== pw.value;
            P.$('#confirm-error').classList.toggle('hidden', !mismatch);
            confirmInput.setAttribute('aria-invalid', String(!!mismatch));
            return !mismatch;
        };
        confirmInput.addEventListener('input', checkMatch);

        form.addEventListener('submit', async function (e) {
            e.preventDefault();
            P.showError(errorEl, '');
            var username = P.$('#username').value.trim();
            if (username.length < 3) return P.showError(errorEl, 'Choose a username with at least 3 characters.');
            if (pw.value.length < 8) return P.showError(errorEl, 'Your password needs at least 8 characters.');
            if (!checkMatch() || !confirmInput.value) return P.showError(errorEl, 'Passwords do not match.');
            var done = P.busy(P.$('#submit'), 'Creating account');
            try {
                var res = await P.api('POST', '/api/auth/register', {
                    username: username,
                    email: P.$('#email').value.trim(),
                    password: pw.value,
                    confirmPassword: confirmInput.value
                });
                if (res.pending) {
                    P.$('#pending-name').textContent = username;
                    P.$('#register-card').classList.add('hidden');
                    P.$('#pending-card').classList.remove('hidden');
                } else {
                    location.href = '/';
                }
            } catch (err) {
                P.showError(errorEl, err.message);
                done();
            }
        });
    }
})();
