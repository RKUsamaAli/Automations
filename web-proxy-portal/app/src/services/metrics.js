'use strict';
/**
 * Server health metrics + process lifecycle.
 *
 * Every process (portal, proxy engine, each engine worker) writes one row per
 * minute to `server_metrics`: memory, CPU, event-loop delay, machine load and
 * free memory, requests / errors / p95 response time in that minute, active
 * sessions. When the server misbehaves (slow, restarts, crashes), Admin ->
 * Server shows what was happening before it.
 *
 * Lifecycle: `process_start` / `process_stop` events with pid, release and
 * memory. If the previous instance of the same process never logged a stop,
 * `process_unclean_exit` is recorded (crash, out-of-memory kill, power loss).
 *
 *   metrics.start('web');                 // at boot
 *   metrics.observe(statusCode, ms);      // per request (cheap, in memory)
 */
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const db = require('../db');
const config = require('../config');
const events = require('./events');
const log = require('../lib/logger')('metrics');

const INTERVAL_MS = Number(process.env.METRICS_INTERVAL_MS) || 60000;

let name = null;
let timer = null;
let loop = null;
let lastCpu = process.cpuUsage();
let lastAt = Date.now();
let window = { requests: 0, errors: 0, durations: [] };

/** Record one finished request (status 0 = failed connection). */
function observe(status, ms) {
    window.requests += 1;
    if (!status || status >= 500) window.errors += 1;
    if (window.durations.length < 20000) window.durations.push(ms);
}

function p95(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
}

function sample() {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - lastAt);
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    lastAt = now;
    const mem = process.memoryUsage();
    const w = window;
    window = { requests: 0, errors: 0, durations: [] };
    const lag = loop ? loop.percentile(99) / 1e6 : null;
    if (loop) loop.reset();
    let activeSessions = null;
    try {
        activeSessions = db.get().prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get().n;
    } catch (_) {
        /* db busy - skip this value */
    }
    const row = {
        ts: now,
        process: name,
        pid: process.pid,
        release: config.releaseName,
        uptime_s: Math.round(process.uptime()),
        rss_mb: +(mem.rss / 1048576).toFixed(1),
        heap_mb: +(mem.heapUsed / 1048576).toFixed(1),
        cpu_pct: +(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100).toFixed(1),
        load1: +os.loadavg()[0].toFixed(2),
        free_mem_mb: +(os.freemem() / 1048576).toFixed(0),
        loop_lag_ms: lag == null ? null : +lag.toFixed(1),
        requests: w.requests,
        errors: w.errors,
        p95_ms: p95(w.durations),
        active_sessions: activeSessions
    };
    try {
        db.get()
            .prepare(
                `INSERT INTO server_metrics (ts, process, pid, release, uptime_s, rss_mb, heap_mb, cpu_pct, load1, free_mem_mb, loop_lag_ms, requests, errors, p95_ms, active_sessions)
                 VALUES (@ts, @process, @pid, @release, @uptime_s, @rss_mb, @heap_mb, @cpu_pct, @load1, @free_mem_mb, @loop_lag_ms, @requests, @errors, @p95_ms, @active_sessions)`
            )
            .run(row);
    } catch (e) {
        log.warn('could not store metrics', e);
    }
    // Same numbers in the process log, for log shippers / grep.
    log.info('health', row);
    // Early warnings in the log (and so in Admin -> Server via the metrics rows).
    if (row.loop_lag_ms > 500) log.warn('event loop blocked', { process: name, loop_lag_ms: row.loop_lag_ms });
    if (row.free_mem_mb < 100) log.warn('machine is low on memory', { free_mem_mb: row.free_mem_mb });
    return row;
}

/**
 * Starts collection for this process and records the start (and any unclean
 * exit before it). processName must be unique per instance: 'web:0', 'web:1',
 * 'proxy', 'proxy:2' ...
 */
function start(processName) {
    name = processName;
    try {
        loop = monitorEventLoopDelay({ resolution: 20 });
        loop.enable();
    } catch (_) {
        loop = null;
    }
    try {
        const conn = db.get();
        const last = conn
            .prepare("SELECT type, detail, created_at FROM events WHERE type IN ('process_start','process_stop') AND detail LIKE ? ORDER BY id DESC LIMIT 1")
            .get(`${processName} %`);
        // A start without a stop is only "unclean" if that process is really gone:
        // during a zero-downtime reload the old instance is still running.
        const lastPid = last && Number((String(last.detail).match(/pid (\d+)/) || [])[1]);
        const stillRunning = (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (e) {
                return e.code === 'EPERM';
            }
        };
        if (last && last.type === 'process_start' && lastPid && lastPid !== process.pid && !stillRunning(lastPid)) {
            const prev = conn
                .prepare('SELECT rss_mb, loop_lag_ms, free_mem_mb, ts FROM server_metrics WHERE process = ? ORDER BY id DESC LIMIT 1')
                .get(processName);
            events.record('process_unclean_exit', {
                detail: `${processName}: previous instance stopped without a clean shutdown (crash, out-of-memory kill or power loss)` +
                    (prev ? `; last sample ${new Date(prev.ts).toISOString()}: rss ${prev.rss_mb} MB, loop lag ${prev.loop_lag_ms} ms, machine free ${prev.free_mem_mb} MB` : '')
            });
            log.warn(`${processName}: previous instance did not shut down cleanly`);
        }
    } catch (_) {
        /* first start */
    }
    events.record('process_start', { detail: `${processName} pid ${process.pid} release ${config.releaseName} node ${process.version}` });
    timer = setInterval(sample, INTERVAL_MS);
    timer.unref();
}

/** Call on graceful shutdown. */
function stop(reason = 'signal') {
    if (!name) return;
    try {
        sample();
    } catch (_) {
        /* best effort */
    }
    const rss = (process.memoryUsage().rss / 1048576).toFixed(0);
    events.record('process_stop', { detail: `${name} pid ${process.pid} (${reason}, uptime ${Math.round(process.uptime())} s, rss ${rss} MB)` });
    if (timer) clearInterval(timer);
    name = null;
}

/** Series for Admin -> Server. */
function series(hours = 24) {
    const since = Date.now() - hours * 3600000;
    return db
        .get()
        .prepare('SELECT ts, process, pid, release, rss_mb, heap_mb, cpu_pct, load1, free_mem_mb, loop_lag_ms, requests, errors, p95_ms, active_sessions, uptime_s FROM server_metrics WHERE ts >= ? ORDER BY ts')
        .all(since);
}

function prune(days = 30) {
    return db.get().prepare('DELETE FROM server_metrics WHERE ts < ?').run(Date.now() - days * 86400000).changes;
}

module.exports = { start, stop, observe, sample, series, prune };
