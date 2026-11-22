'use strict';
/**
 * Tiny leveled logger. Writes one line per message to stdout/stderr;
 * PM2 captures both into /opt/proxy-portal/shared/logs/*.log.
 *
 *   const log = require('../lib/logger')('web');
 *   log.info('listening', { port: 3000 });
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
    const name = (process.env.LOG_LEVEL || 'info').toLowerCase();
    return LEVELS[name] ?? LEVELS.info;
}

function format(scope, level, msg, meta) {
    let line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}`;
    if (meta !== undefined) {
        if (meta instanceof Error) line += ` ${meta.stack || meta.message}`;
        else {
            try {
                line += ' ' + JSON.stringify(meta);
            } catch (_) {
                line += ' [unserializable meta]';
            }
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
