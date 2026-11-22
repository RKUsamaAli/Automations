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
        await expect(admin.getByRole('heading', { name: 'Sign in' })).toBeVisible();
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
        await expect(admin.locator('#proxy-list tbody').getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });
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
        await expect(admin.locator('#proxy-list tbody').getByText('Online', { exact: true })).toBeVisible({ timeout: 20000 });
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
        await expect(phone.locator('.user-menu')).toContainText(user.name);
        const options = await phone.locator('#pool option').allTextContents();
        expect(options.join('|')).toContain(pools.shared);
        expect(options.join('|')).toContain(pools.assigned);
        // Admin changes reach every portal process within a few seconds (short config cache).
        await expect(async () => {
            await phone.reload();
            await expect(phone.getByRole('button', { name: new RegExp(siteName) })).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 10000 });
        await shot(phone, '10-browse-iphone');
        // address bar suggests the admin's sites while typing
        await phone.locator('#url').fill(siteName);
        await expect(phone.getByRole('group', { name: 'Your sites' }).getByRole('option', { name: new RegExp(siteName) })).toBeVisible();
        await shot(phone, '10b-browse-suggestions-iphone', { fullPage: false });
        await phone.locator('#url').press('Escape');
        await expect(phone.getByRole('listbox')).toBeHidden();
        await phone.locator('#url').fill('');
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
    test('address bar searches like Google: suggestions, results page, pick a result', async () => {
        // admin points search at the fake engine (Settings -> Search -> Custom)
        await admin.getByRole('button', { name: 'Settings' }).click();
        await admin.locator('#set-search_engine').selectOption('custom');
        await admin.locator('#set-search_url_custom').fill('http://shop.localtest/search?q={q}');
        await admin.locator('#set-search_suggest_url_custom').fill(`http://127.0.0.1:${S.sitePort || 17001}/suggest?q={q}`);
        await admin.locator('#save-settings').click();
        await expect(admin.getByText('Settings saved')).toBeVisible();
        await phone.goto(S.appUrl + '/');
        await phone.waitForTimeout(3500); // settings cache in every process
        await phone.locator('#url').fill('lemons');
        await expect(phone.getByRole('option', { name: /lemons\s*Search/ }).first()).toBeVisible();
        await expect(phone.getByRole('group', { name: 'Search suggestions' })).toContainText('lemons recipes');
        await shot(phone, '10c-search-suggestions-iphone', { fullPage: false });
        await phone.getByRole('option', { name: /lemons recipes/ }).click();
        await expect(phone.locator('#search-title')).toHaveText('Results for "lemons recipes"');
        expect(phone.url()).toMatch(new RegExp('^' + S.proxyUrl.replace(/[.]/g, '\\.') + '/[0-9a-f]{32}/')); // opened THROUGH the proxy (address is scrambled by the engine)
        await shot(phone, '10d-search-results-iphone', { fullPage: false });
        await phone.locator('#result-1').click();
        await expect(phone.locator('#shop-title')).toHaveText('Fresh picks today');
        await phone.goto(S.appUrl + '/');
        // typing an address still opens the site directly
        await phone.locator('#url').fill('http://shop.localtest/login'); // typed addresses default to https; the fake shop is http only
        await phone.locator('#url').press('Escape');
        await phone.locator('#go').click();
        await expect(phone.locator('#shop-login')).toBeVisible();
        await phone.goto(S.appUrl + '/');
    });

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
        await phone.getByRole('button', { name: 'Open', exact: true }).click();
        await expect(phone.locator('#shop-title')).toBeVisible();
        await expect(phone.locator('#via-name')).toHaveText('Your own proxy');
        ownProxyUrl = phone.url();
        await shot(phone, '15-proxied-via-own-proxy-iphone');
        await phone.locator('#__portal_home').click();
    });

    test('a session shows its proxy and can be switched to another one', async () => {
        await expect(phone).toHaveURL(S.appUrl + '/');
        // the session opened through "My proxies" shows that proxy (127.0.0.1:<port> in the test setup)
        const own = phone.locator('#sessions li').filter({ has: phone.locator('.via-line', { hasText: 'My proxies' }) }).first();
        await expect(own).toBeVisible();
        await shot(phone, '15b-session-shows-proxy-iphone', { fullPage: false });
        await own.getByRole('button', { name: /Change the proxy/ }).click();
        const dialog = phone.getByRole('dialog', { name: 'Change proxy' });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.proxy-option').filter({ hasText: 'Current' })).toHaveCount(1);
        await shot(phone, '15c-change-proxy-iphone', { fullPage: false });
        // pick a proxy from the shared admin pool (not the current one)
        await dialog.locator('fieldset', { hasText: pools.shared }).locator('.proxy-option:not(.disabled)').first().click();
        await dialog.getByRole('button', { name: 'Use this proxy' }).click();
        await expect(phone.getByText(/Now using/)).toBeVisible();
        await expect(own.locator('.via-line')).toContainText(pools.shared);
        // the next page of that session really goes out through the new upstream
        await expect(async () => {
            await phone.goto(ownProxyUrl);
            await expect(phone.locator('#via-name')).toHaveText('Admin provider (US)', { timeout: 1000 });
        }).toPass({ timeout: 10000 });
        await phone.locator('#__portal_home').click();
    });

    // ------------------------------------------------------------ cleanup --
    test('ending a session kills its link', async () => {
        await expect(phone.locator('#sessions li').first()).toBeVisible();
        const before = await phone.locator('#sessions li').count(); // site tile, own proxy, search, typed address
        expect(before).toBeGreaterThanOrEqual(2);
        const first = phone.locator('#sessions li').filter({ hasText: 'shop.localtest' }).last();
        await first.getByRole('button', { name: 'End' }).click();
        await expect(phone.getByRole('alertdialog')).toBeVisible();
        await shot(phone, '16-end-session-confirm-iphone', { fullPage: false });
        await phone.getByRole('alertdialog').getByRole('button', { name: 'End session' }).click();
        await expect(phone.locator('#sessions li')).toHaveCount(before - 1);
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
        // every page a session loaded (successful ones too) is in its timeline
        // the request log is written in 2 s batches: reopen until the page row is there
        await expect(async () => {
            await admin.keyboard.press('Escape');
            await admin.locator('tr', { hasText: user.name }).first().getByRole('button', { name: 'Timeline' }).click();
            await expect(admin.locator('#modal tbody tr', { hasText: 'http://shop.localtest/' }).first()).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 10000 });
        await expect(admin.locator('#modal tbody tr').first()).toContainText('200');
        await shot(admin, '18b-admin-session-timeline', { fullPage: false });
        await admin.keyboard.press('Escape');
        // the request log: what users did, successful or not
        await admin.getByRole('button', { name: 'Requests' }).click();
        await expect(admin.locator('#view tbody tr').first()).toBeVisible();
        await expect(admin.locator('#view')).toContainText('shop.localtest');
        await shot(admin, '18c-admin-requests', { fullPage: false });
        await admin.waitForTimeout(11000); // usage counters are flushed to the database every 10 s
        await admin.getByRole('button', { name: 'Dashboard' }).click();
        await expect(admin.getByRole('heading', { name: 'Traffic, last 24 hours' })).toBeVisible();
        await shot(admin, '19-admin-dashboard');
        // server health: one sample per process per minute + start/stop events
        await admin.getByRole('button', { name: 'Server' }).click();
        await expect(admin.getByRole('heading', { name: 'Processes' })).toBeVisible();
        await expect(admin.locator('#view')).toContainText('Process started');
        await shot(admin, '19d-admin-server');
        await admin.getByRole('button', { name: 'Settings' }).click();
        await expect(admin.locator('#set-registration_mode')).toBeVisible();
        await shot(admin, '20-admin-settings');
    });

    test('long lists load in batches while scrolling; the summary counts the whole set', async () => {
        // 130 portal API calls -> 130+ rows of type "Portal API" in the request log
        // (sent from the page, so they use the browser's host mapping and the admin's cookies)
        // Each call carries this run's marker, so the list below holds exactly these
        // 130 rows (the log on a shared test server keeps growing run after run).
        const marker = `lazy${S.run}`;
        await admin.evaluate(async (m) => {
            // paced at ~15/s: nginx allows 20 requests/s per IP (more would get 429 there)
            for (let i = 0; i < 130; i++) {
                await fetch('/api/admin/overview?e2e=' + m + '&i=' + i, { credentials: 'same-origin' });
                await new Promise((r) => setTimeout(r, 65));
            }
        }, marker);
        await admin.getByRole('button', { name: 'Requests' }).click();
        await admin.locator('#rkind').selectOption('api');
        const filtered = admin.waitForResponse((r) => r.url().includes('/api/admin/requests?') && r.url().includes('q=' + marker));
        await admin.locator('#rq').fill(marker);
        await admin.locator('#rq').blur(); // (Escape would clear a search box)
        await filtered; // the search box applies after a short pause
        const rows = admin.locator('#req-list tbody tr');
        const summary = admin.locator('#req-list .summary-bar');
        // rows are written in 2 s batches: reload the list until all 130 are counted
        await expect(async () => {
            await admin.locator('#rhours').selectOption('1');
            await admin.locator('#rhours').selectOption('24');
            await expect(summary).toBeVisible({ timeout: 1000 });
            const total = Number((await summary.locator('b').first().textContent() || '0').replace(/\D/g, ''));
            expect(total).toBeGreaterThanOrEqual(130); // + the list's own calls (their URL has the marker too)
        }).toPass({ timeout: 15000 });
        const total = Number((await summary.locator('b').first().textContent() || '0').replace(/\D/g, ''));
        // first request: one batch of 50 rows + the summary of everything
        await expect(rows).toHaveCount(50);
        await expect(admin.locator('#req-list .lazy-status')).toHaveText(`50 of ${total.toLocaleString('en-US')} shown · scroll for more`);
        await shot(admin, '18d-admin-requests-summary', { fullPage: false });
        // scrolling to the end loads the next batch, and the next...
        await rows.last().scrollIntoViewIfNeeded();
        await expect(rows).toHaveCount(100);
        await admin.mouse.wheel(0, 100000);
        await expect(rows).toHaveCount(Math.min(150, total));
        await expect(summary.locator('b').first()).toHaveText(total.toLocaleString('en-US'), { useInnerText: true }); // summary unchanged
        // keyboard / fallback path: "Load more" until everything is shown
        await expect(async () => {
            const more = admin.locator('#req-list [data-more]');
            if (await more.isVisible()) await more.click();
            await expect(admin.locator('#req-list .lazy-status')).toHaveText(/^All .* shown$/, { timeout: 500 });
        }).toPass({ timeout: 20000 });
        await expect(rows).toHaveCount(total); // every row exactly once, nothing skipped
        // search suggests users and sites; picking a user filters by that user (removable chip)
        await admin.locator('#rq').fill(user.name.slice(0, 8));
        const opt = admin.getByRole('option', { name: new RegExp(user.name) });
        await expect(opt).toBeVisible();
        await expect(admin.getByRole('group', { name: 'Users' })).toBeVisible();
        await admin.locator('#rkind').selectOption('');
        await admin.locator('#rq').fill(user.name.slice(0, 8));
        await expect(opt).toBeVisible();
        await admin.evaluate(() => window.scrollTo(0, 0));
        await shot(admin, '18f-admin-requests-suggestions', { fullPage: false });
        await opt.click();
        await expect(admin.locator('#req-chips')).toContainText('User: ' + user.name);
        await expect(async () => {
            // the cell shows the username, then the device on a second line
            const names = await admin.locator('#req-list tbody tr td:nth-child(2)').evaluateAll((tds) => tds.map((td) => td.firstChild.textContent));
            expect(names.length).toBeGreaterThan(0);
            expect(new Set(names)).toEqual(new Set([user.name]));
        }).toPass({ timeout: 5000 });
        await admin.getByRole('button', { name: 'Remove filter User: ' + user.name }).click();
        await expect(admin.locator('#req-chips')).toBeEmpty();
        await admin.locator('#req-list .lazy-foot').scrollIntoViewIfNeeded();
        await shot(admin, '18e-admin-requests-scrolled', { fullPage: false });
    });

    test('a page that fails shows a friendly error with a reference; the admin finds it with the steps', async () => {
        await phone.goto(S.appUrl + '/');
        await phone.locator('#url').fill('http://broken.localtest/checkout');
        await phone.getByRole('button', { name: 'Open', exact: true }).click();
        await expect(phone.getByRole('heading', { name: "This page couldn't load" })).toBeVisible({ timeout: 20000 });
        const ref = await phone.locator('.ref code').textContent();
        expect(ref).toMatch(/^E-[2-9A-HJ-NP-Z]{6}$/);
        await shot(phone, '19a-page-error-iphone');

        await admin.getByRole('button', { name: /Errors/ }).click();
        await admin.locator('#error-q').fill(ref);
        await expect(admin.getByText('All 1 shown', { exact: true })).toBeVisible(); // search applied (debounced)
        await admin.waitForTimeout(400);
        const row = admin.locator('tr', { hasText: ref });
        await expect(row).toBeVisible();
        await expect(row.getByText('Page failed to load')).toBeVisible();
        await shot(admin, '19b-admin-errors');
        await row.getByRole('button', { name: 'View' }).click();
        const steps = admin.getByRole('list', { name: 'Steps before the error' });
        await expect(steps).toContainText('Session started');
        await expect(steps).toContainText('http://broken.localtest/checkout');
        await expect(steps).toContainText('Signed in');
        await expect(admin.locator('#modal')).toContainText(user.name);
        await shot(admin, '19c-admin-error-detail', { fullPage: false });
        await admin.getByRole('button', { name: 'Mark resolved' }).click();
        await expect(admin.getByText('Marked resolved')).toBeVisible();

        await phone.getByRole('link', { name: 'Back to portal' }).click();
        await expect(phone).toHaveURL(S.appUrl + '/');
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

    test('dark mode: System / Light / Dark switch', async () => {
        await login(phone, user.name, user.pass); // the previous step signed out
        await expect(phone).toHaveURL(S.appUrl + '/');
        // phone: one button showing the current mode; each tap cycles System -> Light -> Dark
        await expect(phone.getByRole('button', { name: 'Light theme' })).toBeHidden();
        await phone.getByRole('button', { name: 'System theme' }).click();
        await expect(phone.locator('html')).toHaveAttribute('data-theme', 'light');
        await phone.getByRole('button', { name: 'Light theme' }).click();
        await expect(phone.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(phone.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true');
        await shot(phone, '23-browse-dark-iphone', { fullPage: false });
        await phone.reload();
        await expect(phone.locator('html')).toHaveAttribute('data-theme', 'dark'); // remembered, applied before paint
        await admin.getByRole('button', { name: 'Dark theme' }).click();
        await admin.getByRole('button', { name: 'Dashboard' }).click();
        await expect(admin.getByRole('heading', { name: 'Traffic, last 24 hours' })).toBeVisible();
        await shot(admin, '24-admin-dashboard-dark', { fullPage: false });
        await admin.getByRole('button', { name: 'System theme' }).click();
        await expect(admin.locator('html')).not.toHaveAttribute('data-theme', /./);
        await phone.getByRole('button', { name: 'Dark theme' }).click(); // dark -> system
        await expect(phone.locator('html')).not.toHaveAttribute('data-theme', /./);
    });

    test('expired sign-in: password prompt over the page, then it simply continues', async () => {
        await phone.goto(S.appUrl + '/');
        await expect(phone.locator('#sessions')).toBeVisible();
        // The 5-minute access token runs out: the page renews it silently.
        await phone.context().clearCookies({ name: 'pp_at' });
        const renewed = phone.waitForResponse((r) => r.url().endsWith('/api/auth/refresh') && r.status() === 200);
        await phone.getByRole('button', { name: 'Refresh' }).click();
        await renewed; // the sessions call got 401 access_token_expired -> renewed -> retried
        await expect(phone.locator('.reauth')).toHaveCount(0);
        await expect.poll(async () => (await phone.context().cookies()).some((c) => c.name === 'pp_at'), { message: 'new access token' }).toBe(true);
        // The 24-hour identity token runs out (simulated): the prompt appears over the page.
        await phone.route('**/api/auth/refresh', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your sign-in has expired', code: 'identity_expired', username: user.name }) }), { times: 1 });
        await phone.context().clearCookies({ name: 'pp_at' });
        // typing asks for suggestions -> the API call finds the sign-in expired -> prompt
        await phone.locator('#url').fill('typed before the prompt');
        const prompt = phone.getByRole('alertdialog', { name: 'Your session has expired' });
        await expect(prompt).toBeVisible();
        await expect(prompt).toContainText(user.name);
        await shot(phone, '25-session-expired-prompt-iphone', { fullPage: false });
        await prompt.getByLabel('Password').fill('wrong-password');
        await prompt.getByRole('button', { name: 'Continue' }).click();
        await expect(prompt.getByRole('alert')).toHaveText('Invalid username or password');
        await prompt.getByLabel('Password').fill(user.pass);
        await prompt.getByRole('button', { name: 'Continue' }).click();
        await expect(prompt).toBeHidden();
        await expect(phone.locator('#url')).toHaveValue('typed before the prompt'); // nothing lost
        await expect(phone.locator('#sessions li').first()).toBeVisible();
        await phone.locator('#url').fill('');
        await phone.locator('#shell-logout').click(); // the next step starts signed out
        await expect(phone).toHaveURL(/signedout/);
    });

    test('user changes password; the old password stops working', async () => {
        await login(phone, user.name, user.pass);
        await expect(phone).toHaveURL(S.appUrl + '/');
        await phone.goto(S.appUrl + '/account');
        await phone.getByLabel('Current password', { exact: true }).fill(user.pass);
        await phone.getByLabel('New password', { exact: true }).fill(user.newPass);
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
