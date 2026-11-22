/* Account page: profile, change password, sign out (here / everywhere). */
(function () {
    'use strict';
    var P = window.Portal;
    P.setupReveal(document);

    P.shell('account').then(function (me) {
        if (!me.user) return;
        var u = me.user;
        var rows = [
            ['Username', u.username],
            ['E-mail', u.email || 'Not set'],
            ['Role', u.role === 'admin' ? 'Administrator' : 'Member'],
            ['Member since', new Date(u.createdAt).toLocaleDateString()],
            ['Last sign-in', u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '-'],
            ['Time zone', P.tz + ' (' + P.tzOffset() + ') · from this device']
        ];
        P.$('#profile').innerHTML = rows.map(function (r) { return '<dt>' + P.esc(r[0]) + '</dt><dd>' + P.esc(r[1]) + '</dd>'; }).join('');
        var tb = P.$('#toolbar-on');
        tb.checked = u.toolbarEnabled !== false;
        tb.addEventListener('change', async function () {
            try {
                await P.api('PUT', '/api/portal/preferences', { toolbarEnabled: tb.checked });
                P.toast(tb.checked ? 'Toolbar on. It shows on the next page you open.' : 'Toolbar off');
            } catch (err) {
                tb.checked = !tb.checked;
                P.toast(err.message);
            }
        });
    });

    P.$('#pw-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = P.$('#pw-msg');
        var next = P.$('#new').value;
        if (next.length < 8) {
            msg.className = 'alert error';
            msg.textContent = 'The new password needs at least 8 characters.';
            return;
        }
        var done = P.busy(P.$('#pw-save'), 'Saving');
        try {
            await P.api('POST', '/api/auth/password', { currentPassword: P.$('#current').value, newPassword: next });
            msg.className = 'alert success';
            msg.textContent = 'Password updated.';
            P.$('#current').value = '';
            P.$('#new').value = '';
        } catch (err) {
            msg.className = 'alert error';
            msg.textContent = err.message;
        }
        done();
    });

    P.$('#logout').addEventListener('click', function () { P.logout(false); });
    P.$('#logout-all').addEventListener('click', async function () {
        if (await P.confirm('You will be signed out on all devices and every browsing session ends.', { title: 'Sign out everywhere?', confirmLabel: 'Sign out everywhere', danger: true })) P.logout(true);
    });
})();
