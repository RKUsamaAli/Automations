'use strict';
/**
 * PROXY ENGINE process - serves PROXY_DOMAIN (e.g. https://browse.example.com)
 *
 * This is Rammerhead (server-side web proxy) wrapped with our features:
 *   - guard.js     : auth, session ownership, allowlist, rate limits, usage
 *   - upstream.js  : sticky upstream proxy per session (+ SOCKS5 bridge)
 *   - routes.js    : /__portal/start hand-off, /__portal/inject.js scripts
 *   - jobs         : proxy health checks, session sync, DB maintenance
 *
 * Ports (bound to 127.0.0.1, nginx in front):
 *   PROXY_PORT              (8080) <- nginx :443  on PROXY_DOMAIN
 *   PROXY_CROSS_DOMAIN_PORT (8081) <- nginx :8443 on PROXY_DOMAIN
 *     (hammerhead uses a 2nd origin to emulate cross-origin iframes correctly)
 *
 * Process model:
 *   PROXY_WORKERS=0  -> one process (recommended for 1-2 vCPU)
 *   PROXY_WORKERS=N  -> Rammerhead's sticky cluster: 1 primary + N workers,
 *                       requests of one session always hit the same worker.
 *
 * Run:  node src/proxy/server.js   (PM2 app "portal-proxy")
 */
const cluster = require('cluster');
const fs = require('fs');
const config = require('../config');
const db = require('../db');
const log = require('../lib/logger')(`proxy${cluster.isPrimary ? '' : ':' + cluster.worker.id}`);

config.validate();
db.open();
db.assertMigrated();

const rh = require('./rammerhead');
const usage = require('../services/usage');
const { createGuard } = require('./guard');
const { setupRoutes, ensureInjector } = require('./routes');
const socksBridge = require('./socksBridge');
const observability = require('./observability');
const errorReports = require('../services/errorReports');

const useWorkers = config.proxy.workers > 0;
const isPrimary = cluster.isPrimary;

for (const dir of [config.paths.sessionsDir, config.paths.jsCacheDir]) fs.mkdirSync(dir, { recursive: true });

// ----------------------------------------------------------- rammerhead ----
const rhLogger = new rh.RammerheadLogging({
    logLevel: config.logLevel === 'debug' ? 'debug' : config.logLevel === 'error' ? 'error' : 'warn',
    generatePrefix: (level) => `[${new Date().toISOString()}] [${level.toUpperCase()}] [rammerhead${isPrimary ? '' : ':' + cluster.worker.id}] `
});

const jsCache =
    config.proxy.jsCacheType === 'disk'
        ? new rh.RammerheadJSFileCache(config.paths.jsCacheDir, config.proxy.jsCacheMb * 1024 * 1024, 50000, useWorkers)
        : new rh.RammerheadJSMemCache(config.proxy.jsCacheMb * 1024 * 1024);

const getIP = (req) => req.portalClientIp || (config.trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress;

const proxyServer = new rh.RammerheadProxy({
    logger: rhLogger,
    loggerGetIP: getIP,
    bindingAddress: config.proxy.host,
    port: config.proxy.port,
    crossDomainPort: config.proxy.crossDomainPort,
    dontListen: useWorkers, // sticky-session does the listening in cluster mode
    ssl: null, // TLS is terminated by nginx
    // Tell hammerhead how the PUBLIC urls look, so it rewrites links correctly.
    getServerInfo: () => ({
        hostname: config.proxyDomain,
        port: config.publicPort,
        crossDomainPort: config.publicCrossDomainPort,
        protocol: config.publicProtocol + ':'
    }),
    disableLocalStorageSync: false,
    jsCache,
    disableHttp2: config.proxy.disableHttp2
});

// Session store: files in shared/data/sessions. Rammerhead purges idle and
// too-old sessions itself (only the primary runs the cleanup).
const sessionStore = new rh.RammerheadSessionFileCache({
    logger: rhLogger,
    saveDirectory: config.paths.sessionsDir,
    cacheTimeout: 20 * 60000, // unload from memory after 20 min without use
    cacheCheckInterval: 10 * 60000,
    deleteUnused: true,
    deleteCorruptedSessions: true,
    staleCleanupOptions: isPrimary
        ? {
              staleTimeout: config.session.idleTimeoutMin * 60000,
              maxToLive: config.session.maxLifetimeHours ? config.session.maxLifetimeHours * 3600000 : null,
              staleCheckInterval: config.session.cleanupIntervalMin * 60000
          }
        : null
});
sessionStore.attachToProxy(proxyServer);
// Every time a session is loaded from disk, make sure our script loader is attached.
// Every time a session is loaded: attach our script loader, and replace
// Rammerhead's no-op page-error hook (otherwise a failed page load hangs the
// browser until the stuck-request timeout) with error page + error report.
sessionStore.onSessionCreate((session) => {
    ensureInjector(session);
    session.handlePageError = observability.makePageErrorHandler(session);
});

// Our guard must run before everything else Rammerhead does with a request.
proxyServer.addToOnRequestPipeline(createGuard({ rh, sessionStore }));
setupRoutes({ proxyServer, sessionStore, rh });

// --------------------------------------------------------------- usage ----
const flushTimer = setInterval(() => {
    try {
        usage.flush();
    } catch (e) {
        log.error('usage flush failed', e);
    }
}, 10000);
flushTimer.unref();

// ---------------------------------------------------------------- jobs ----
if (isPrimary) {
    require('../jobs/healthCheck').schedule();
    require('../jobs/maintenance').schedule();
    require('./sessionSync').schedule(sessionStore);
}

// ------------------------------------------------------------ shutdown ----
const exitHook = rh.rhRequire('async-exit-hook');
let shuttingDown = false;
exitHook(() => {
    shuttingDown = true;
    log.info('exit signal: saving sessions and closing');
    try {
        usage.flush();
    } catch (_) {
        /* best effort */
    }
    socksBridge.closeAll();
    proxyServer.close(); // also saves in-memory sessions to disk
    db.close();
});

// ------------------------------------------------------------- listen ----
if (!useWorkers) {
    log.info(`proxy engine listening on ${config.proxy.host}:${config.proxy.port} + ${config.proxy.crossDomainPort} (public: ${config.proxyBaseUrl}, release: ${config.releaseName})`);
} else {
    const sticky = rh.rhRequire('sticky-session-custom');
    // Same hashing as Rammerhead's own server: route by session id so one
    // session always lands on the same worker.
    const stickyOptions = {
        workers: config.proxy.workers,
        generatePrehashArray(req) {
            let sessionId = rh.getSessionId(req.url);
            if (!sessionId) {
                const parsed = new URL(req.url, 'https://a.com');
                sessionId = parsed.searchParams.get('id') || parsed.searchParams.get('sessionId');
                if (!sessionId) {
                    for (let i = 0; i < req.headers.length; i += 2) {
                        if (req.headers[i].toLowerCase() === 'referer') {
                            sessionId = rh.getSessionId(req.headers[i + 1]);
                            break;
                        }
                    }
                }
            }
            return (sessionId || ' ').split('').map((c) => c.charCodeAt(0));
        }
    };
    const closers = [
        sticky.listen(proxyServer.server1, config.proxy.port, config.proxy.host, stickyOptions),
        sticky.listen(proxyServer.server2, config.proxy.crossDomainPort, config.proxy.host, stickyOptions)
    ];
    if (closers[0]) {
        log.info(`proxy primary: ${config.proxy.workers} workers on ${config.proxy.host}:${config.proxy.port} + ${config.proxy.crossDomainPort}`);
        // If a worker dies, exit so PM2 restarts the whole engine cleanly.
        cluster.on('exit', (worker, code, signal) => {
            if (shuttingDown || worker.exitedAfterDisconnect) return; // normal stop/restart
            log.error(`worker ${worker.id} died (code ${code}, signal ${signal}) - restarting engine`);
            process.exit(1);
        });
        exitHook(async (done) => {
            for (const close of closers) await new Promise((r) => close(r));
            done();
        });
    }
}

// In cluster mode PM2's max_memory_restart only sees the primary, so each
// worker watches its own memory and exits (-> engine restart) when too big.
if (useWorkers && !isPrimary) {
    const limitMb = Number(process.env.PROXY_WORKER_MAX_MEMORY_MB) || 0;
    if (limitMb) {
        setInterval(() => {
            const rssMb = process.memoryUsage().rss / 1048576;
            if (rssMb > limitMb) {
                log.error(`worker memory ${rssMb.toFixed(0)}MB > ${limitMb}MB, exiting`);
                process.exit(1);
            }
        }, 30000).unref();
    }
}

process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', e);
    errorReports.report({ source: 'proxy', kind: 'process_exception', error: e instanceof Error ? e : String(e) });
});
