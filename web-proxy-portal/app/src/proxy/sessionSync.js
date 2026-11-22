'use strict';
/**
 * Keeps the `sessions` table and Rammerhead's session files in agreement.
 * Runs every 30 s in the primary proxy process.
 *
 *  - sessions the portal asked to end (end_requested=1) -> delete Rammerhead session
 *  - sessions Rammerhead already purged (idle / max lifetime) -> mark ended in DB
 *
 * Rammerhead itself purges idle sessions (SESSION_IDLE_TIMEOUT_MIN) every
 * SESSION_CLEANUP_INTERVAL_MIN; see `fileCacheSessionConfig` in server.js.
 */
const sessions = require('../services/sessions');
const events = require('../services/events');
const log = require('../lib/logger')('session-sync');

function run(sessionStore) {
    let ended = 0;
    let expired = 0;
    for (const id of sessions.listEndRequested()) {
        try {
            sessionStore.delete(id);
        } catch (e) {
            log.warn(`could not delete session ${id.slice(0, 8)}: ${e.message}`);
        }
        sessions.markEnded(id, 'ended');
        ended++;
    }
    for (const id of sessions.listActiveIds()) {
        if (!sessionStore.has(id)) {
            sessions.markEnded(id, 'expired');
            expired++;
        }
    }
    if (ended || expired) {
        log.info('sessions synced', { ended, expired });
        if (expired) events.record('sessions_expired', { detail: `${expired} idle session(s) purged` });
    }
}

function schedule(sessionStore) {
    const tick = () => {
        try {
            run(sessionStore);
        } catch (e) {
            log.error('session sync failed', e);
        }
    };
    const timer = setInterval(tick, 30000);
    timer.unref();
    setTimeout(tick, 5000).unref();
    return () => clearInterval(timer);
}

module.exports = { run, schedule };
