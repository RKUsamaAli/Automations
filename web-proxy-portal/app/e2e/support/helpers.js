'use strict';
/** Shared helpers for the browser tests. */
const fs = require('fs');
const path = require('path');
const { devices } = require('@playwright/test');

const state = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../.state.json'), 'utf8'));
const SHOTS = path.join(__dirname, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/** iPhone-sized context (Chromium with the iPhone 13 viewport/UA/touch). */
const IPHONE = (() => {
    const d = { ...devices['iPhone 13'] };
    delete d.defaultBrowserType;
    return d;
})();
const DESKTOP = { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 2 };

/**
 * Full-page screenshot named NN-name.png (numbered in journey order).
 * For the capture only: toasts are removed and sticky/fixed bars (top bar,
 * admin tabs, phone tab bar) are laid out in normal flow, so a full-page
 * image shows each of them once, where they belong, instead of mid-page.
 */
async function shot(page, name, opts = {}) {
    await page.waitForTimeout(250); // let transitions settle
    const fullPage = opts.fullPage !== false;
    if (fullPage) {
        await page.evaluate(() => {
            document.querySelectorAll('.toast').forEach((t) => t.remove());
            document.querySelectorAll('.topbar, .admin-tabs, .bottomnav').forEach((el) => {
                el.dataset.shotPos = el.style.position || '';
                el.style.position = 'static';
            });
            document.body.classList.remove('has-bottomnav');
            window.scrollTo(0, 0);
        }).catch(() => {});
    }
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage, animations: 'disabled' });
    if (fullPage) {
        await page.evaluate(() => {
            document.querySelectorAll('[data-shot-pos]').forEach((el) => {
                el.style.position = el.dataset.shotPos;
                delete el.dataset.shotPos;
            });
            if (document.querySelector('.bottomnav')) document.body.classList.add('has-bottomnav');
        }).catch(() => {});
    }
}

async function login(page, username, password) {
    const s = state();
    await page.goto(s.appUrl + '/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
}

module.exports = { state, shot, login, IPHONE, DESKTOP, SHOTS };
