'use strict';
/**
 * Leveled, structured logger for SYSTEM / technical logs.
 *
 * Where logs go (by design):
 *   - user & admin ACTIONS (sign-in, user created, pool edited, deploy ...)
 *     -> SQLite `events` table (Admin -> Activity log), see services/events.js
 *   - what users did / failures -> SQLite `request_log` / `error_reports`
 *   - SYSTEM logs (start-up, health samples, warnings, internal errors)
 *     -> FILES, written here:
 *          <LOG_DIR>/YYYY-MM-DD.<process>.log   (one JSON object per line, UTC dates)
 *        LOG_DIR defaults to <DATA_DIR>/../logs/app (= shared/logs/app on the server).
 *        Files older than LOG_FILE_RETENTION_DAYS (default 14) are deleted daily.
 *     -> and stdout/stderr (PM2 keeps shared/logs/{web,proxy}.{out,err}.log)
 *
 * Every file line has: ts, level, scope, msg, server, process, pid, release
 * (+ requestId / userId when given), so one grep follows a request across
 * processes:   grep <request-id> shared/logs/app/*.log
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
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const HOST = os.hostname();

// ------------------------------------------------------------ file output --
function logDir() {
    if (process.env.LOG_DIR) return path.resolve(process.env.LOG_DIR);
    if (process.env.NODE_ENV === 'test') return null; // tests: console only unless LOG_DIR is set
    const data = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');
    return path.join(data, '..', 'logs', 'app');
}
let file = { day: null, stream: null, failed: false };
function processName() {
    try {
        return require('./system').info().process;
    } catch (_) {
        return 'app';
    }
}
function release() {
    try {
        return require('./system').info().release;
    } catch (_) {
        return null;
    }
}
/** Appends one JSON line to today's file (new file at UTC midnight). Never throws. */
function writeFile(obj) {
    if (file.failed) return;
    const dir = logDir();
    if (!dir) return;
    try {
        const day = new Date().toISOString().slice(0, 10);
        const proc = processName().replace(/[^a-z0-9:_-]/gi, '_').replace(/:/g, '-');
        const key = `${day}.${proc}`;
        if (file.day !== key) {
            if (file.stream) file.stream.end();
            fs.mkdirSync(dir, { recursive: true });
            file = { day: key, stream: fs.createWriteStream(path.join(dir, `${key}.log`), { flags: 'a' }), failed: false };
            file.stream.on('error', (e) => {
                file.failed = true; // e.g. disk full: keep logging to the console only
                process.stderr.write(`[logger] cannot write log file: ${e.message}\n`);
            });
        }
        file.stream.write(JSON.stringify(obj) + '\n');
    } catch (e) {
        file.failed = true;
        process.stderr.write(`[logger] cannot write log file: ${e.message}\n`);
    }
}

/** Deletes log files older than `days` (called by the maintenance job). */
function pruneFiles(days = Number(process.env.LOG_FILE_RETENTION_DAYS) || 14) {
    const dir = logDir();
    if (!dir || !fs.existsSync(dir)) return 0;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\./.exec(f);
        if (m && m[1] < cutoff) {
            fs.rmSync(path.join(dir, f), { force: true });
            n += 1;
        }
    }
    return n;
}

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
        let data;
        try {
            data = serializeMeta(meta);
            JSON.stringify(data);
        } catch (_) {
            data = { meta: '[unserializable]' };
        }
        writeFile({ ts: new Date().toISOString(), level, scope, msg, server: HOST, process: processName(), pid: process.pid, release: release(), ...data });
    };
    return {
        debug: out('debug', process.stdout),
        info: out('info', process.stdout),
        warn: out('warn', process.stderr),
        error: out('error', process.stderr)
    };
};
module.exports.pruneFiles = pruneFiles;
module.exports.logDir = logDir;
