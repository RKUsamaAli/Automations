/* Account page: profile, change password, sign out (here / everywhere). */
(function () {
    'use strict';
    var P = window.Portal;
    P.setupReveal(document);

    P.shell('account').then(function (me) {
        if (!me.user) return;
        var u = me.user;
        P.$('#avatar').textContent = u.username.charAt(0);
        P.$('#avatar').style.background = P.colorFor(u.username);
        P.$('#profile-title').textContent = u.username;
        P.$('#profile-meta').textContent = [u.email, u.role === 'admin' ? 'Administrator' : 'Member', 'joined ' + new Date(u.createdAt).toLocaleDateString()].filter(Boolean).join(' · ');
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
