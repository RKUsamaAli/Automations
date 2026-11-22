'use strict';
/**
 * Starts everything the browser tests need.
 *
 * LOCAL mode (default): temporary database + portal-web + portal-proxy
 *   (real Rammerhead engine) + an nginx-like gateway, all on 127.0.0.1.
 *   Needs a built engine: RAMMERHEAD_DIR or app/vendor/rammerhead.
 *
 * REMOTE mode: set E2E_APP_URL, E2E_PROXY_URL, E2E_ADMIN_USER, E2E_ADMIN_PASS
 *   to test an already deployed server (e.g. the stack installed by
 *   setup-server.sh + deploy.sh). That server's .env needs
 *   HEALTHCHECK_URL=http://health.localtest/204 and ALLOW_PRIVATE_UPSTREAMS=true
 *   because the fake upstream proxies run on 127.0.0.1.
 *
 * In both modes the fake target site and fake upstream proxies are started
 * here (support/fakes.js). Browsers resolve *.localtest to 127.0.0.1.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { startTargetSite, startUpstreamProxy } = require('./fakes');
const { createGateway } = require('./gateway');

const APP_DIR = path.resolve(__dirname, '../..');
const STATE_FILE = path.join(__dirname, '../.state.json');
const PORTS = {
    site: Number(process.env.E2E_SITE_PORT) || 17001,
    upstreamAdmin: Number(process.env.E2E_UPSTREAM_ADMIN_PORT) || 17002,
    upstreamUser: Number(process.env.E2E_UPSTREAM_USER_PORT) || 17003,
    gateway: 18080,
    gatewayCross: 18443,
    web: 18100,
    proxy: 18101,
    proxyCross: 18102
};

async function waitFor(url, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

module.exports = async function globalSetup() {
    const handles = [];
    handles.push(await startTargetSite(PORTS.site));
    handles.push(await startUpstreamProxy({ port: PORTS.upstreamAdmin, name: 'Admin provider (US)', user: 'pa', pass: 'pa-secret', sitePort: PORTS.site }));
    handles.push(await startUpstreamProxy({ port: PORTS.upstreamUser, name: 'Your own proxy', user: 'pu', pass: 'pu-secret', sitePort: PORTS.site }));
    const children = [];

    let state;
    if (process.env.E2E_APP_URL) {
        state = {
            mode: 'remote',
            appUrl: process.env.E2E_APP_URL.replace(/\/$/, ''),
            proxyUrl: (process.env.E2E_PROXY_URL || '').replace(/\/$/, ''),
            admin: { username: process.env.E2E_ADMIN_USER, password: process.env.E2E_ADMIN_PASS }
        };
        if (!state.admin.username || !state.admin.password) throw new Error('Set E2E_ADMIN_USER and E2E_ADMIN_PASS for remote mode');
    } else {
        const rhDir = path.resolve(APP_DIR, process.env.RAMMERHEAD_DIR || 'vendor/rammerhead');
        if (!fs.existsSync(path.join(rhDir, 'src/client/hammerhead.min.js'))) {
            throw new Error(`Rammerhead is not built at ${rhDir}. Set RAMMERHEAD_DIR (see README "Local development").`);
        }
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-e2e-'));
        const admin = { username: 'admin', password: 'Admin-' + crypto.randomBytes(6).toString('hex') };
        const env = {
            ...process.env,
            ENV_FILE: '/dev/null',
            NODE_ENV: 'production',
            LOG_LEVEL: 'warn',
            DATA_DIR: dataDir,
            APP_SECRET: crypto.randomBytes(40).toString('hex'),
            APP_DOMAIN: 'portal.localtest',
            PROXY_DOMAIN: 'browse.localtest',
            PUBLIC_PROTOCOL: 'http',
            PUBLIC_PORT: String(PORTS.gateway),
            PUBLIC_CROSS_DOMAIN_PORT: String(PORTS.gatewayCross),
            WEB_PORT: String(PORTS.web),
            PROXY_PORT: String(PORTS.proxy),
            PROXY_CROSS_DOMAIN_PORT: String(PORTS.proxyCross),
            RAMMERHEAD_DIR: rhDir,
            HEALTHCHECK_URL: 'http://health.localtest/204',
            HEALTHCHECK_INTERVAL_MIN: '1',
            ALLOW_PRIVATE_UPSTREAMS: 'true'
        };
        const cli = (...args) => execFileSync(process.execPath, [path.join(APP_DIR, 'src/cli/index.js'), ...args], { env, stdio: 'pipe' });
        cli('migrate');
        cli('create-admin', admin.username, admin.password);

        const logFile = fs.openSync(path.join(dataDir, 'servers.log'), 'a');
        for (const script of ['src/web/server.js', 'src/proxy/server.js']) {
            children.push(spawn(process.execPath, [path.join(APP_DIR, script)], { env, stdio: ['ignore', logFile, logFile] }));
        }
        handles.push(await createGateway({ listenPort: PORTS.gateway, appHost: 'portal.localtest', webPort: PORTS.web, proxyPort: PORTS.proxy }));
        handles.push(await createGateway({ listenPort: PORTS.gatewayCross, appHost: '-', webPort: PORTS.proxyCross, proxyPort: PORTS.proxyCross }));
        await waitFor(`http://127.0.0.1:${PORTS.web}/healthz`);
        await waitFor(`http://127.0.0.1:${PORTS.proxy}/__portal/healthz`);
        state = {
            mode: 'local',
            appUrl: `http://portal.localtest:${PORTS.gateway}`,
            proxyUrl: `http://browse.localtest:${PORTS.gateway}`,
            admin,
            dataDir
        };
    }

    state.upstreams = {
        admin: `http://pa:pa-secret@127.0.0.1:${PORTS.upstreamAdmin}`,
        user: `http://pu:pu-secret@127.0.0.1:${PORTS.upstreamUser}`
    };
    state.run = Date.now().toString(36).slice(-5); // unique names, so remote runs can repeat
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    return async () => {
        for (const c of children) c.kill('SIGINT');
        for (const h of handles) h.close();
        await new Promise((r) => setTimeout(r, 500));
    };
};
