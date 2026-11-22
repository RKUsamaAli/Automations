'use strict';
/**
 * Leveled, structured logger. PM2 writes stdout/stderr to
 * /opt/proxy-portal/shared/logs/{web,proxy}.{out,err}.log.
 *
 *   const log = require('../lib/logger')('web');
 *   log.info('listening', { port: 3000 });
 *   log.error('payment failed', err);            // Error -> message + stack
 *   log.warn('slow upstream', { requestId, ms }); // requestId ties lines together
 *
 * LOG_FORMAT=json (default in production): one JSON object per line, e.g.
 *   {"ts":"2026-11-22T14:00:00.000Z","level":"error","scope":"proxy","msg":"page_load_failed: ...","ref":"E-7K2P9Q","requestId":"..."}
 *   -> grep / jq / any log shipper can analyse it:  jq 'select(.level=="error")' proxy.err.log
 * LOG_FORMAT=text: human friendly lines for development.
 *
 * Secrets are never passed to the logger directly - see lib/redact.js.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
    const name = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVELS[name] ?? LEVELS.info;
}

function useJson() {
    const f = (process.env.LOG_FORMAT || '').toLowerCase();
    if (f) return f === 'json';
    return process.env.NODE_ENV === 'production';
}

function serializeMeta(meta) {
    if (meta === undefined) return {};
    if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
    if (meta && typeof meta === 'object') return meta;
    return { value: meta };
}

function format(scope, level, msg, meta) {
    const data = serializeMeta(meta);
    if (useJson()) {
        try {
            return JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, pid: process.pid, ...data });
        } catch (_) {
            return JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, pid: process.pid, meta: '[unserializable]' });
        }
    }
    let line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}`;
    if (meta instanceof Error) line += ` ${meta.stack || meta.message}`;
    else if (meta !== undefined) {
        try {
            line += ' ' + JSON.stringify(data);
        } catch (_) {
            line += ' [unserializable meta]';
        }
    }
    return line;
}

module.exports = function createLogger(scope) {
    const out = (level, stream) => (msg, meta) => {
        if (LEVELS[level] < currentLevel()) return;
        stream.write(format(scope, level, msg, meta) + '\n');
    };
    return {
        debug: out('debug', process.stdout),
        info: out('info', process.stdout),
        warn: out('warn', process.stderr),
        error: out('error', process.stderr)
    };
};
