'use strict';
/**
 * Housekeeping that keeps the database small. Runs hourly in the proxy
 * process (primary only).
 */
const db = require('../db');
const events = require('../services/events');
const sessions = require('../services/sessions');
const log = require('../lib/logger')('maintenance');

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;

function run() {
    const ticketRows = db.get().prepare('DELETE FROM used_tickets WHERE expires_at < ?').run(Date.now()).changes;
    const eventRows = events.prune(RETENTION_DAYS);
    const sessionRows = sessions.pruneEnded(RETENTION_DAYS);
    const usageRows = db
        .get()
        .prepare('DELETE FROM usage_daily WHERE day < ?')
        .run(new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)).changes;
    if (ticketRows + eventRows + sessionRows + usageRows) {
        log.info('pruned old rows', { tickets: ticketRows, events: eventRows, sessions: sessionRows, usage: usageRows });
    }
}

function schedule() {
    const tick = () => {
        try {
            run();
        } catch (e) {
            log.error('maintenance failed', e);
        }
    };
    const timer = setInterval(tick, 3600000);
    timer.unref();
    setTimeout(tick, 60000).unref();
    return () => clearInterval(timer);
}

module.exports = { run, schedule };
