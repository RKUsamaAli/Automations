'use strict';
/**
 * Housekeeping that keeps the database small. Runs hourly in the proxy
 * process (primary only).
 */
const db = require('../db');
const events = require('../services/events');
const sessions = require('../services/sessions');
const errorReports = require('../services/errorReports');
const requestLog = require('../services/requestLog');
const metrics = require('../services/metrics');
const log = require('../lib/logger')('maintenance');

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 30;

function run() {
    const ticketRows = db.get().prepare('DELETE FROM used_tickets WHERE expires_at < ?').run(Date.now()).changes;
    const eventRows = events.prune(RETENTION_DAYS);
    const sessionRows = sessions.pruneEnded(RETENTION_DAYS);
    const errorRows = errorReports.prune(Number(process.env.ERROR_RETENTION_DAYS) || 30);
    const requestRows = requestLog.prune(Number(process.env.REQUEST_LOG_RETENTION_DAYS) || 14);
    const metricRows = metrics.prune(Number(process.env.METRICS_RETENTION_DAYS) || 30);
    const checkRows = db.get().prepare('DELETE FROM proxy_checks WHERE ts < ?').run(Date.now() - 30 * 86400000).changes;
    const usageRows = db
        .get()
        .prepare('DELETE FROM usage_daily WHERE day < ?')
        .run(new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)).changes;
    if (ticketRows + eventRows + sessionRows + usageRows + errorRows + requestRows + metricRows + checkRows) {
        log.info('pruned old rows', { tickets: ticketRows, events: eventRows, sessions: sessionRows, usage: usageRows, errorReports: errorRows, requests: requestRows, metrics: metricRows, proxyChecks: checkRows });
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
