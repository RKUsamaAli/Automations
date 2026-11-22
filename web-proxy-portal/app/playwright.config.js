// @ts-check
/**
 * Browser journey tests (Playwright). Run:
 *
 *   RAMMERHEAD_DIR=/path/to/built/rammerhead npm run e2e     # local: starts its own stack
 *   E2E_APP_URL=http://portal.localtest E2E_PROXY_URL=http://browse.localtest \
 *   E2E_ADMIN_USER=admin E2E_ADMIN_PASS=... npm run e2e      # against a deployed server
 *
 * Screenshots of every screen are written to e2e/screenshots/.
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e/tests',
    globalSetup: require.resolve('./e2e/support/global-setup.js'),
    fullyParallel: false,
    workers: 1, // one user journey, in order
    timeout: 60000,
    expect: { timeout: 10000 },
    reporter: [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]],
    outputDir: 'e2e/test-results',
    use: {
        browserName: 'chromium',
        // *.localtest (portal, proxy, fake shop) -> this machine
        launchOptions: { args: ['--host-resolver-rules=MAP *.localtest 127.0.0.1'] },
        trace: 'off',
        screenshot: 'only-on-failure',
        actionTimeout: 15000,
        navigationTimeout: 30000
    }
});
