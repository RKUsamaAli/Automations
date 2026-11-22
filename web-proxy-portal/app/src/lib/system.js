'use strict';
/**
 * Who/where is this process - attached to every stored log row and file log
 * line so problems can be traced to a server, process and release.
 *
 *   system.info()      -> { server, process, release }
 *   system.snapshot()  -> node version, memory, load, uptime ... (stored with error reports)
 */
const os = require('os');

const SERVER = os.hostname();
let processName = process.env.PORTAL_PROCESS || 'app';

/** Set once at start-up: 'web:0', 'proxy', 'proxy:2', 'cli', 'jobs'. */
function setProcessName(name) {
    processName = name;
}

function release() {
    try {
        return require('../config').releaseName;
    } catch (_) {
        return null;
    }
}

function info() {
    return { server: SERVER, process: processName, release: release() };
}

function snapshot() {
    const mem = process.memoryUsage();
    return {
        server: SERVER,
        process: processName,
        pid: process.pid,
        release: release(),
        node: process.version,
        platform: `${os.type()} ${os.release()} (${process.arch})`,
        uptimeS: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        load1: Number(os.loadavg()[0].toFixed(2)),
        freeMemMb: Math.round(os.freemem() / 1048576),
        totalMemMb: Math.round(os.totalmem() / 1048576),
        cpus: os.cpus().length
    };
}

module.exports = { setProcessName, info, snapshot, SERVER };
