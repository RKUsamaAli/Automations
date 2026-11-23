/**
 * PM2 process definition (used by deploy.sh / rollback.sh).
 *
 *   portal-web   - login, landing page, admin panel, API   (APP_DOMAIN)
 *   portal-proxy - Rammerhead proxy engine                 (PROXY_DOMAIN)
 *   portal-search - headless Chromium for Google results    (127.0.0.1 only)
 *   portal-live   - live browser: real Chromium per user      (127.0.0.1 only)
 *
 * IMPORTANT: paths point at /opt/proxy-portal/current (a symlink). A deploy or
 * rollback only re-points that symlink and reloads PM2, so both processes
 * start from the selected release.
 *
 * Memory guard: `max_memory_restart` restarts a process that grows too big
 * (Node.js + Rammerhead can leak on long sessions). Tune in shared/.env:
 *   WEB_MAX_MEMORY=200M  PROXY_MAX_MEMORY=700M
 */
const path = require('path');
const fs = require('fs');

// Read .env so PM2 settings can be tuned without editing this file.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) require('dotenv').config({ path: envFile });

const BASE = process.env.PORTAL_BASE_DIR || '/opt/proxy-portal';
const CURRENT = path.join(BASE, 'current');
const LOGS = path.join(BASE, 'shared', 'logs');

module.exports = {
    apps: [
        {
            name: 'portal-web',
            cwd: CURRENT,
            script: path.join(CURRENT, 'src/web/server.js'),
            exec_mode: 'cluster', // cluster mode = zero-downtime `pm2 reload`
            instances: Number(process.env.WEB_INSTANCES) || 1,
            wait_ready: true, // server.js sends "ready" once listening
            listen_timeout: 10000,
            kill_timeout: 8000,
            max_memory_restart: process.env.WEB_MAX_MEMORY || '200M',
            env: { NODE_ENV: 'production' },
            out_file: path.join(LOGS, 'web.out.log'),
            error_file: path.join(LOGS, 'web.err.log'),
            merge_logs: true,
            time: false
        },
        {
            name: 'portal-proxy',
            cwd: CURRENT,
            script: path.join(CURRENT, 'src/proxy/server.js'),
            exec_mode: 'fork', // Rammerhead manages its own workers (PROXY_WORKERS)
            instances: 1,
            kill_timeout: 10000, // time to save sessions to disk on shutdown
            max_memory_restart: process.env.PROXY_MAX_MEMORY || '700M',
            node_args: process.env.PROXY_NODE_ARGS || '--max-old-space-size=768',
            env: { NODE_ENV: 'production' },
            out_file: path.join(LOGS, 'proxy.out.log'),
            error_file: path.join(LOGS, 'proxy.err.log'),
            merge_logs: true,
            time: false,
            exp_backoff_restart_delay: 200 // back off if it crash-loops
        },
        {
            // Google results via a real headless browser (Google refuses
            // proxy-rewritten search pages). Internal only: 127.0.0.1:SEARCH_PORT.
            name: 'portal-search',
            cwd: CURRENT,
            script: path.join(CURRENT, 'src/search/worker.js'),
            exec_mode: 'fork',
            instances: 1,
            kill_timeout: 8000,
            max_memory_restart: process.env.SEARCH_MAX_MEMORY || '600M', // node side; Chromium is a child process
            env: { NODE_ENV: 'production', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(BASE, 'shared', 'ms-playwright') },
            out_file: path.join(LOGS, 'search.out.log'),
            error_file: path.join(LOGS, 'search.err.log'),
            merge_logs: true,
            time: false,
            exp_backoff_restart_delay: 500
        },
        {
            // Live browser: a real Chromium per user, shown in the page (/live)
            // over a WebSocket that portal-web hands through. 127.0.0.1:LIVE_PORT.
            name: 'portal-live',
            cwd: CURRENT,
            script: path.join(CURRENT, 'src/live/worker.js'),
            exec_mode: 'fork',
            instances: 1,
            kill_timeout: 10000,
            max_memory_restart: process.env.LIVE_MAX_MEMORY || '400M', // node side; each Chromium is its own process
            env: { NODE_ENV: 'production', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(BASE, 'shared', 'ms-playwright') },
            out_file: path.join(LOGS, 'live.out.log'),
            error_file: path.join(LOGS, 'live.err.log'),
            merge_logs: true,
            time: false,
            exp_backoff_restart_delay: 500
        }
    ]
};
