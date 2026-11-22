// @ts-check
/**
 * THE USER JOURNEY - the whole product, in a real browser, in order:
 *
 *  admin  : sign in -> create a shared pool + import provider proxy -> health "Online"
 *           -> create an "assigned only" pool -> add a site tile -> add an injected script
 *  visitor: sign-up form validation -> create account -> "waiting for approval"
 *           -> sign-in refused while pending
 *  admin  : sees the pending badge -> approves -> assigns the private pool to the user
 *  user   : (iPhone) sign in -> Browse -> tap the site tile -> page loads THROUGH the
 *           admin's upstream proxy, custom script injected, Portal button shown
 *           -> signs in to the shop (cookies through the proxy) -> back to portal
 *           -> resume session (still signed in) -> add own proxy -> browse through it
 *           -> end session -> old link is dead -> change password -> sign out
 *           -> proxy refuses access when signed out
 *
 * Screenshots: e2e/screenshots/NN-*.png
 */
const { test, expect } = require('@playwright/test');
const { state, shot, login, IPHONE, DESKTOP } = require('../support/helpers');

test.describe.serial('full product journey', () => {
    const S = state();
    const user = { name: `alice${S.run}`, email: `alice${S.run}@example.com`, pass: 'Alice-pass-123', newPass: 'Alice-pass-456' };
    const pools = { shared: `US Residential ${S.run}`, assigned: `Partner UK ${S.run}` };
    const siteName = `Demo Shop ${S.run}`;
    /** @type {import('@playwright/test').Page} */ let admin;
    /** @type {import('@playwright/test').Page} */ let phone;
    let proxiedUrl = '';
    let ownProxyUrl = '';

    test.beforeAll(async ({ browser }) => {
        admin = await (await browser.newContext(DESKTOP)).newPage();
        phone = await (await browser.newContext(IPHONE)).newPage();
    });

    // ------------------------------------------------------------- admin --
    test('admin signs in and sees the dashboard', async () => {
        await admin.goto(S.appUrl + '/login');
        await expect(admin.getByRole('heading', { name: 'Web Portal' })).toBeVisible();
        await shot(admin, '01-login-desktop');
        await login(admin, S.admin.username, S.admin.password);
        await expect(admin).toHaveURL(S.appUrl + '/');
        await admin.getByRole('link', { name: 'Admin' }).first().click();
        await expect(admin.getByText('Active sessions')).toBeVisible();
        await shot(admin, '02-admin-dashboard-empty');
    });

    test('admin creates a shared pool and imports the provider proxy (health check -> Online)', async () => {
        await admin.getByRole('button', { name: 'Proxy pools' }).click();
        await admin.getByRole('button', { name: 'Add pool' }).click();
        await admin.locator('#f-name').fill(pools.shared);
        await admin.locator('#f-type').selectOption('residential');
        await admin.locator('#f-country').fill('US');
        await admin.locator('#f-visibility').selectOption('all');
        await admin.locator('#modal-submit').click();
        const row = admin.locator('tr', { hasText: pools.shared });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Proxies' }).click();
        await admin.locator('#import').click();
        await admin.locator('#f-text').fill(S.upstreams.admin);
        await admin.locator('#modal-submit').click();
        await expect(admin.getByText(/Added\s+1/)).toBeVisible();
        await admin.locator('#modal-done').click();
        await admin.locator('#check').click();
        await expect(admin.locator('#pool-detail').getByText('Online')).toBeVisible({ timeout: 20000 });
    });

    test('admin creates a pool only assigned users may use', async () => {
        await admin.getByRole('button', { name: 'Add pool' }).click();
        await admin.locator('#f-name').fill(pools.assigned);
        await admin.locator('#f-type').selectOption('isp');
        await admin.locator('#f-country').fill('UK');
        await admin.locator('#f-visibility').selectOption('assigned');
        await admin.locator('#modal-submit').click();
        const row = admin.locator('tr', { hasText: pools.assigned });
        await expect(row.getByText('0 assigned users')).toBeVisible();
        await row.getByRole('button', { name: 'Proxies' }).click();
        await admin.locator('#import').click();
        await admin.locator('#f-text').fill(S.upstreams.admin);
        await admin.locator('#modal-submit').click();
        await admin.locator('#modal-done').click();
        await admin.locator('#check').click();
        await expect(admin.locator('#pool-detail').getByText('Online')).toBeVisible({ timeout: 20000 });
        await shot(admin, '03-admin-proxy-pools');
    });

    test('admin adds a site tile and an injected script', async () => {
        await admin.getByRole('button', { name: 'Sites' }).click();
        await admin.getByRole('button', { name: 'Add site' }).click();
        await admin.locator('#f-name').fill(siteName);
        await admin.locator('#f-startUrl').fill('http://shop.localtest/');
        await admin.locator('#f-domains').fill('*.localtest');
        await admin.locator('#modal-submit').click();
        await expect(admin.locator('tr', { hasText: siteName })).toBeVisible();

        await admin.getByRole('button', { name: 'Scripts' }).click();
        await admin.getByRole('button', { name: 'Add script' }).click();
        await admin.locator('#f-name').fill(`Welcome ribbon ${S.run}`);
        await admin.locator('#f-domains').fill('shop.localtest');
        await admin.locator('#f-code').fill(
            "var r = document.createElement('div');\n" +
            "r.id = 'portal-ribbon-" + S.run + "';\n" +
            "r.textContent = 'Injected by the portal on ' + window.__portal.page.host;\n" +
            "r.style.cssText = 'background:#2f5fe3;color:#fff;padding:8px 14px;font:600 14px system-ui';\n" +
            'document.body.prepend(r);'
        );
        await admin.locator('#modal-submit').click();
        await expect(admin.locator('tr', { hasText: `Welcome ribbon ${S.run}` })).toBeVisible();
        await shot(admin, '04-admin-scripts');
    });

    // ----------------------------------------------------------- sign-up --
    test('visitor signs up on an iPhone (validation, then pending approval)', async () => {
        await phone.goto(S.appUrl + '/login');
        await phone.getByRole('link', { name: 'Create an account' }).click();
        await expect(phone.getByRole('heading', { name: 'Create your account' })).toBeVisible();
        await phone.getByLabel('Username').fill(user.name);
        await phone.getByLabel(/E-mail/).fill(user.email);
        await phone.getByLabel('Password', { exact: true }).fill(user.pass);
        await phone.getByLabel('Confirm password').fill('something-else');
        await phone.getByRole('button', { name: 'Create account' }).click();
        await expect(phone.getByRole('alert')).toHaveText('Passwords do not match.');
        await shot(phone, '05-register-validation-iphone');

        await phone.getByLabel('Confirm password').fill(user.pass);
        await phone.getByRole('button', { name: 'Create account' }).click();
        await expect(phone.getByRole('heading', { name: 'Request received' })).toBeVisible();
        await shot(phone, '06-register-pending-iphone');
    });

    test('pending account cannot sign in yet', async () => {
        await login(phone, user.name, user.pass);
        await expect(phone.getByText('waiting for an administrator to approve')).toBeVisible();
        await shot(phone, '07-login-pending-iphone');
    });

    test('admin approves the account and assigns the private pool', async () => {
        await admin.getByRole('button', { name: /Users/ }).click();
        await expect(admin.getByRole('heading', { name: 'Awaiting approval' })).toBeVisible();
        await expect(admin.locator('#pending-count')).toBeVisible();
        await shot(admin, '08-admin-pending-approval');
        await admin.locator('li', { hasText: user.name }).getByRole('button', { name: 'Approve' }).click();
        await expect(admin.getByText(`${user.name} can sign in now`)).toBeVisible();

        await admin.getByRole('button', { name: 'Proxy pools' }).click();
        await admin.locator('tr', { hasText: pools.assigned }).getByRole('button', { name: 'Users' }).click();
        await admin.locator('label.check', { hasText: user.name }).locator('input').check();
        await shot(admin, '09-admin-assign-pool-to-user', { fullPage: false });
        await admin.getByRole('button', { name: 'Save access' }).click();
        await expect(admin.locator('tr', { hasText: pools.assigned }).getByText('1 assigned user')).toBeVisible();
    });

    // -------------------------------------------------------------- browse --
    test('user signs in and sees the Browse screen with allowed pools', async () => {
        await login(phone, user.name, user.pass);
        await expect(phone).toHaveURL(S.appUrl + '/');
        await expect(phone.getByRole('heading', { name: new RegExp(user.name) })).toBeVisible();
        const options = await phone.locator('#pool option').allTextContents();
        expect(options.join('|')).toContain(pools.shared);
        expect(options.join('|')).toContain(pools.assigned);
        await expect(phone.getByRole('button', { name: new RegExp(siteName) })).toBeVisible();
        await shot(phone, '10-browse-iphone');
    });

    test('tapping the site opens it THROUGH the admin proxy, with the injected script', async () => {
        await phone.locator('#pool').selectOption({ label: `${pools.shared} · US` });
        await phone.getByRole('button', { name: new RegExp(siteName) }).click();
        await expect(phone.locator('#shop-title')).toHaveText('Fresh picks today');
        proxiedUrl = phone.url();
        expect(new URL(proxiedUrl).hostname).toBe('browse.localtest');
        await expect(phone.locator('#via-name')).toHaveText('Admin provider (US)');
        await expect(phone.locator(`#portal-ribbon-${S.run}`)).toHaveText('Injected by the portal on shop.localtest');
        await expect(phone.locator('#__portal_home')).toBeVisible();
        await shot(phone, '11-proxied-site-iphone');
    });

    test('user signs in to the shop - cookies work through the proxy', async () => {
        await phone.getByRole('link', { name: 'sign in' }).click();
        await phone.locator('#shop-user').fill(user.name);
        await phone.locator('#shop-pass').fill('shop-pass');
        await phone.locator('#shop-login').click();
        await expect(phone.locator('#welcome')).toHaveText(`Welcome back, ${user.name}!`);
        await shot(phone, '12-proxied-site-logged-in-iphone');
    });

    test('Portal button returns to the portal; session is listed and can be resumed', async () => {
        await phone.locator('#__portal_home').click();
        await expect(phone).toHaveURL(S.appUrl + '/');
        const session = phone.locator('#sessions li', { hasText: 'shop.localtest' });
        await expect(session).toBeVisible();
        await shot(phone, '13-sessions-iphone');
        await session.getByRole('button', { name: 'Resume' }).click();
        await expect(phone.getByText(`Signed in as ${user.name}`)).toBeVisible();
        await phone.locator('#__portal_home').click();
    });

    // ---------------------------------------------------------- own proxy --
    test('user adds their own proxy and it becomes Online', async () => {
        await phone.getByRole('link', { name: 'My proxies' }).first().click();
        await expect(phone.getByRole('heading', { name: 'My proxies', level: 1 })).toBeVisible();
        await phone.locator('#text').fill(`${S.upstreams.user}\n127.0.0.1:1:bad:entry`);
        await phone.getByRole('button', { name: 'Add proxies' }).click();
        await expect(phone.locator('#add-result')).toContainText('2 added');
        await phone.getByRole('button', { name: 'Check now' }).click();
        await expect(phone.locator('#list li', { hasText: '17003' }).getByText('Online')).toBeVisible({ timeout: 20000 });
        await expect(phone.locator('#list li', { hasText: 'bad:' }).getByText(/Not responding|Offline|Checking/)).toBeVisible();
        await shot(phone, '14-my-proxies-iphone');
        // remove the broken one
        await phone.locator('#list li', { hasText: 'bad:' }).getByRole('button', { name: 'Remove' }).click();
        await phone.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
        await expect(phone.locator('#list li', { hasText: 'bad:' })).toHaveCount(0);
    });

    test('browsing through "My proxies" really uses the user\'s own proxy', async () => {
        await phone.getByRole('link', { name: 'Browse' }).first().click();
        await phone.locator('#pool').selectOption({ label: 'My proxies' });
        await expect(phone.locator('#pool-health')).toHaveText('1 of 1 online');
        await phone.locator('#url').fill('http://shop.localtest/'); // the fake shop is plain HTTP; without a scheme the portal assumes https://
        await phone.getByRole('button', { name: 'Go' }).click();
        await expect(phone.locator('#shop-title')).toBeVisible();
        await expect(phone.locator('#via-name')).toHaveText('Your own proxy');
        ownProxyUrl = phone.url();
        await shot(phone, '15-proxied-via-own-proxy-iphone');
        await phone.locator('#__portal_home').click();
    });

    // ------------------------------------------------------------ cleanup --
    test('ending a session kills its link', async () => {
        await expect(phone.locator('#sessions li')).toHaveCount(2);
        const first = phone.locator('#sessions li').filter({ hasText: 'shop.localtest' }).last();
        await first.getByRole('button', { name: 'End' }).click();
        await expect(phone.getByRole('alertdialog')).toBeVisible();
        await shot(phone, '16-end-session-confirm-iphone', { fullPage: false });
        await phone.getByRole('alertdialog').getByRole('button', { name: 'End session' }).click();
        await expect(phone.locator('#sessions li')).toHaveCount(1);
        // The proxy notices within ~2 seconds (short cache, separate process).
        await expect(async () => {
            await phone.goto(proxiedUrl);
            await expect(phone.getByRole('heading', { name: /Session (ended|expired)/ })).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 8000 });
        await shot(phone, '17-ended-session-page-iphone');
    });

    test('admin sees live sessions and usage', async () => {
        await admin.getByRole('button', { name: 'Sessions' }).click();
        await expect(admin.locator('tr', { hasText: user.name }).first()).toBeVisible();
        await shot(admin, '18-admin-sessions');
        await admin.waitForTimeout(11000); // usage counters are flushed to the database every 10 s
        await admin.getByRole('button', { name: 'Dashboard' }).click();
        await expect(admin.getByText('Bandwidth (14 days)')).toBeVisible();
        await shot(admin, '19-admin-dashboard');
        await admin.getByRole('button', { name: 'Settings' }).click();
        await expect(admin.locator('#set-registration_mode')).toBeVisible();
        await shot(admin, '20-admin-settings');
    });

    test('signing out also locks the proxy: an open proxied link goes to sign-in', async () => {
        await phone.goto(S.appUrl + '/account');
        await phone.getByRole('button', { name: 'Sign out', exact: true }).last().click();
        await expect(phone).toHaveURL(/\/login\?signedout=1/);
        await expect(phone.getByText('You have been signed out.')).toBeVisible();
        await shot(phone, '21-signed-out-iphone');
        await phone.goto(ownProxyUrl); // the still-active session from the previous step
        await expect(phone).toHaveURL(new RegExp('^' + S.appUrl.replace(/[.]/g, '\\.') + '/login'));
    });

    test('user changes password; the old password stops working', async () => {
        await login(phone, user.name, user.pass);
        await expect(phone).toHaveURL(S.appUrl + '/');
        await phone.goto(S.appUrl + '/account');
        await phone.getByLabel('Current password').fill(user.pass);
        await phone.getByLabel('New password').fill(user.newPass);
        await phone.getByRole('button', { name: 'Update password' }).click();
        await expect(phone.getByText('Password updated.')).toBeVisible();
        await shot(phone, '22-account-iphone');
        await phone.locator('#shell-logout').click();
        await expect(phone).toHaveURL(/signedout/);
        await login(phone, user.name, user.pass);
        await expect(phone.getByRole('alert')).toHaveText('Invalid username or password');
        await login(phone, user.name, user.newPass);
        await expect(phone).toHaveURL(S.appUrl + '/');
    });
});
