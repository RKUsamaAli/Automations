'use strict';
/**
 * Browsers / devices seen ("client_devices"), stored once each and referenced
 * by log rows through client_id.
 *
 * Sources:
 *   - User-Agent + Client Hints headers (every request)
 *   - X-Client header from the portal pages (JSON): screen, pixel ratio,
 *     viewport, languages, time zone, touch, memory, cores, network type
 *
 * resolve() is called on every logged request, so it is cached in memory:
 * the database is only touched for a new device, or to refresh last_seen
 * at most every 10 minutes.
 */
const crypto = require('crypto');
const db = require('../db');
const TtlCache = require('../lib/ttlCache');
const ua = require('../lib/userAgent');

const seen = new TtlCache(10 * 60000, 5000); // fingerprint -> id
const rows = new TtlCache(60000, 1000); // id -> row (admin views)

const clean = (v, max = 64) => (v == null || v === '' ? null : String(v).slice(0, max));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Reads the X-Client header the portal pages send (JSON, size-limited). */
function parseClientHeader(raw) {
    if (!raw || raw.length > 1000) return {};
    try {
        const c = JSON.parse(raw);
        return c && typeof c === 'object' ? c : {};
    } catch (_) {
        return {};
    }
}

/**
 * Finds or creates the device for a request.
 * @param {object} req  { userAgent, hints: {platform, platformVersion, model, mobile}, client: X-Client object }
 * @returns {string|null} client_devices.id
 */
function resolve({ userAgent, hints = {}, client = {} } = {}) {
    if (!userAgent) return null;
    try {
        const p = ua.parse(userAgent, hints);
        const stable = {
            user_agent: clean(userAgent, 400),
            browser: p.browser,
            browser_version: p.browserVersion,
            engine: p.engine,
            os: p.os,
            os_version: clean(p.osVersion, 32),
            device_type: p.deviceType,
            device_model: clean(p.deviceModel),
            screen: /^\d{2,5}x\d{2,5}$/.test(client.screen || '') ? client.screen : null,
            pixel_ratio: num(client.dpr),
            language: clean(client.lang, 35),
            languages: clean(client.langs, 120),
            timezone: clean(client.tz, 64),
            touch: client.touch == null ? null : client.touch ? 1 : 0,
            memory_gb: num(client.mem),
            cpu_cores: num(client.cores)
        };
        const fingerprint = crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex');
        const now = Date.now();
        const cached = seen.get(fingerprint);
        if (cached) return cached;
        const conn = db.get();
        const existing = conn.prepare('SELECT id FROM client_devices WHERE fingerprint = ?').get(fingerprint);
        let id;
        if (existing) {
            id = existing.id;
            conn.prepare('UPDATE client_devices SET last_seen_at = ?, last_viewport = COALESCE(?, last_viewport), last_network = COALESCE(?, last_network), updated_at = ? WHERE id = ?').run(
                now,
                /^\d{2,5}x\d{2,5}$/.test(client.vp || '') ? client.vp : null,
                clean(client.net, 16),
                now,
                id
            );
        } else {
            id = db.insert(
                'client_devices',
                { ...stable, fingerprint, last_seen_at: now, last_viewport: /^\d{2,5}x\d{2,5}$/.test(client.vp || '') ? client.vp : null, last_network: clean(client.net, 16) },
                { orIgnore: true }
            );
            if (!id) id = conn.prepare('SELECT id FROM client_devices WHERE fingerprint = ?').get(fingerprint).id; // another process won the race
        }
        seen.set(fingerprint, id);
        return id;
    } catch (_) {
        return null; // device info must never break a request
    }
}

/** Device info from an Express request (web) or a raw Node request (proxy). */
function fromRequest(req) {
    const h = req.headers || {};
    return resolve({
        userAgent: h['user-agent'],
        hints: { platform: h['sec-ch-ua-platform'], platformVersion: h['sec-ch-ua-platform-version'], model: h['sec-ch-ua-model'], mobile: h['sec-ch-ua-mobile'] },
        client: parseClientHeader(h['x-client'])
    });
}

function get(id) {
    if (!id) return null;
    return rows.get(id, () => db.get().prepare('SELECT * FROM client_devices WHERE id = ?').get(id) || null);
}

/** "Chrome 131 · Android 14 · mobile · 412x915" */
function describe(d) {
    if (!d) return '';
    return [d.browser && `${d.browser}${d.browser_version ? ' ' + d.browser_version : ''}`, d.os && `${d.os}${d.os_version ? ' ' + d.os_version : ''}`, d.device_model, d.device_type, d.screen]
        .filter(Boolean)
        .join(' · ');
}

function prune(days = 180) {
    return db.get().prepare('DELETE FROM client_devices WHERE last_seen_at < ?').run(Date.now() - days * 86400000).changes;
}

module.exports = { resolve, fromRequest, get, describe, prune, parseClientHeader };
