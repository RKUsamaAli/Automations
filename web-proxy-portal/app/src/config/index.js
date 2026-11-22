'use strict';
/**
 * Central configuration loader.
 *
 * Infrastructure settings (domains, ports, secrets, paths, memory) come from
 * environment variables, normally loaded from the `.env` file. On the server
 * that file lives in /opt/proxy-portal/shared/.env and every release gets a
 * symlink to it, so a deploy or rollback never touches your secrets.
 *
 * Settings that an admin changes at runtime (allowlist, rate limits, ...)
 * live in the database instead - see src/services/settings.js.
 */
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '../..');

// Load .env (ENV_FILE lets tests or scripts point somewhere else).
const envFile = process.env.ENV_FILE || path.join(APP_ROOT, '.env');
if (fs.existsSync(envFile)) {
    require('dotenv').config({ path: envFile });
}

// ---- small helpers to read typed env values --------------------------------
const str = (name, def) => (process.env[name] !== undefined && process.env[name] !== '' ? process.env[name] : def);
const int = (name, def) => {
    const v = parseInt(str(name, ''), 10);
    return Number.isFinite(v) ? v : def;
};
const bool = (name, def) => {
    const v = str(name, '');
    if (v === '') return def;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const NODE_ENV = str('NODE_ENV', 'development');
const dataDir = path.resolve(APP_ROOT, str('DATA_DIR', './data'));

const config = {
    env: NODE_ENV,
    isProduction: NODE_ENV === 'production',
    appRoot: APP_ROOT,

    // Public hostnames. The portal (login/landing/admin) and the proxy engine
    // MUST be on different hostnames so proxied websites can never reach the
    // portal's cookies or admin API (see docs/ARCHITECTURE.md -> Security).
    appDomain: str('APP_DOMAIN', 'localhost'),
    proxyDomain: str('PROXY_DOMAIN', '127.0.0.1'),
    // Public ports/protocol as seen by the browser (nginx terminates TLS).
    publicProtocol: str('PUBLIC_PROTOCOL', 'https'),
    publicPort: int('PUBLIC_PORT', 443),
    publicCrossDomainPort: int('PUBLIC_CROSS_DOMAIN_PORT', 8443),

    // One long random secret. Signing keys for cookies and tickets are derived from it.
    appSecret: str('APP_SECRET', ''),

    web: {
        host: str('WEB_HOST', '127.0.0.1'),
        port: int('WEB_PORT', 3000),
        instances: str('WEB_INSTANCES', '1')
    },

    proxy: {
        host: str('PROXY_HOST', '127.0.0.1'),
        port: int('PROXY_PORT', 8080),
        crossDomainPort: int('PROXY_CROSS_DOMAIN_PORT', 8081),
        // Rammerhead's own multi-process mode. 0 = single process (best for 1 vCPU).
        workers: int('PROXY_WORKERS', 0),
        rammerheadDir: path.resolve(APP_ROOT, str('RAMMERHEAD_DIR', './vendor/rammerhead')),
        disableHttp2: bool('PROXY_DISABLE_HTTP2', false),
        jsCacheMb: int('PROXY_JS_CACHE_MB', 50),
        jsCacheType: str('PROXY_JS_CACHE_TYPE', 'memory') // memory | disk
    },

    session: {
        // Proxy browsing sessions (cookies, logins of the target site).
        idleTimeoutMin: int('SESSION_IDLE_TIMEOUT_MIN', 60),
        maxLifetimeHours: int('SESSION_MAX_LIFETIME_HOURS', 24),
        cleanupIntervalMin: int('SESSION_CLEANUP_INTERVAL_MIN', 15),
        // Portal login cookie lifetime.
        loginTtlHours: int('LOGIN_TTL_HOURS', 12)
    },

    healthCheck: {
        enabled: bool('HEALTHCHECK_ENABLED', true),
        url: str('HEALTHCHECK_URL', 'https://www.gstatic.com/generate_204'),
        intervalMin: int('HEALTHCHECK_INTERVAL_MIN', 5),
        timeoutMs: int('HEALTHCHECK_TIMEOUT_MS', 10000),
        slowMs: int('HEALTHCHECK_SLOW_MS', 5000),
        failuresBeforeDead: int('HEALTHCHECK_FAILURES_BEFORE_DEAD', 3),
        concurrency: int('HEALTHCHECK_CONCURRENCY', 10)
    },

    paths: {
        dataDir,
        dbFile: path.join(dataDir, 'portal.db'),
        sessionsDir: path.join(dataDir, 'sessions'),
        jsCacheDir: path.join(dataDir, 'cache-js'),
        backupsDir: path.resolve(APP_ROOT, str('BACKUP_DIR', path.join(dataDir, 'backups')))
    },

    logLevel: str('LOG_LEVEL', 'info'),
    // Trust X-Forwarded-For from nginx (127.0.0.1) to get the real client IP.
    trustProxy: bool('TRUST_PROXY', true),
    // Name of the release folder this code runs from (realpath, so it follows the
    // `current` symlink at process start). deploy.sh / rollback.sh compare it via
    // /healthz to prove the NEW code is really running. Never taken from env,
    // because PM2 keeps old env values across reloads.
    releaseName: path.basename(APP_ROOT)
};

/** Public base URLs used for redirects between the two hostnames. */
const portSuffix = (proto, port) =>
    (proto === 'https' && port === 443) || (proto === 'http' && port === 80) ? '' : `:${port}`;
config.appBaseUrl = `${config.publicProtocol}://${config.appDomain}${portSuffix(config.publicProtocol, config.publicPort)}`;
config.proxyBaseUrl = `${config.publicProtocol}://${config.proxyDomain}${portSuffix(config.publicProtocol, config.publicPort)}`;

/**
 * Fail fast on dangerous misconfiguration. Called by each process at startup
 * (not on require, so unit tests can load this module freely).
 */
config.validate = function validate() {
    const errors = [];
    if (!config.appSecret || config.appSecret.length < 32) {
        errors.push('APP_SECRET must be set to a random string of at least 32 characters (setup-server.sh generates one).');
    }
    if (config.isProduction && config.appDomain === config.proxyDomain) {
        errors.push('APP_DOMAIN and PROXY_DOMAIN must be different hostnames (e.g. portal.example.com and browse.example.com).');
    }
    if (errors.length) {
        for (const e of errors) console.error(`[config] ${e}`);
        process.exit(1);
    }
};

module.exports = config;
