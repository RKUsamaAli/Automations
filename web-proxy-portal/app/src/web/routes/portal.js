'use strict';
/**
 * User-facing API (landing page).
 *
 *   GET    /api/portal/sites            sites shown as tiles
 *   GET    /api/portal/sessions         my active browsing sessions
 *   POST   /api/portal/browse           { url } | { siteId } | { sessionId }  -> { redirect }
 *   DELETE /api/portal/sessions/:id     end one of my sessions
 */
const express = require('express');
const config = require('../../config');
const sites = require('../../services/sites');
const sessions = require('../../services/sessions');
const settings = require('../../services/settings');
const events = require('../../services/events');
const { hostOf } = require('../../lib/domainMatch');
const { mintTicket } = require('../../lib/authTokens');

const router = express.Router();

/** Turns "example.com/path" into "https://example.com/path"; rejects non-http(s). */
function normalizeUrl(input) {
    let raw = String(input || '').trim();
    if (!raw) throw new Error('Enter a website address');
    if (raw.length > 4000) throw new Error('URL is too long');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
    let u;
    try {
        u = new URL(raw);
    } catch (_) {
        throw new Error('That does not look like a valid website address');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses are supported');
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a valid website address');
    // Never let users point the proxy at the server itself / private networks.
    if (isPrivateHost(u.hostname)) throw new Error('That address is not allowed');
    return u.toString();
}

function isPrivateHost(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
    if (h === config.appDomain || h === config.proxyDomain) return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (h.includes(':')) {
        // IPv6 literal: loopback, unique-local (fc00::/7), link-local (fe80::/10)
        return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
    }
    return false;
}

router.get('/sites', (_req, res) => {
    res.json(
        sites
            .listEnabled()
            .filter((s) => s.show_on_landing)
            .map((s) => ({ id: s.id, name: s.name, startUrl: s.start_url, host: hostOf(s.start_url) }))
    );
});

router.get('/sessions', (req, res) => {
    res.json(sessions.listActiveForUser(req.user.id));
});

router.post('/browse', (req, res) => {
    const { url, siteId, sessionId } = req.body || {};
    const user = req.user;

    // Resume an existing session (keeps the site's cookies/logins).
    if (sessionId) {
        const s = sessions.get(String(sessionId));
        if (!s || s.user_id !== user.id || s.ended_at || s.end_requested) {
            return res.status(404).json({ error: 'That session has ended. Start a new one.' });
        }
        const ticket = mintTicket({ uid: user.id, v: user.token_version, sid: s.id, url: url ? safeUrl(url) : null });
        return res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
    }

    let target;
    try {
        if (siteId) {
            const site = sites.listEnabled().find((s) => s.id === Number(siteId));
            if (!site) return res.status(404).json({ error: 'Site not found' });
            target = site.start_url;
        } else {
            target = normalizeUrl(url);
        }
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    if (!sites.isHostAllowed(hostOf(target))) {
        events.record('blocked_domain', { userId: user.id, detail: hostOf(target), ip: req.ip });
        return res.status(403).json({ error: 'This website is not on the list of allowed sites.' });
    }

    const max = settings.get('max_sessions_per_user');
    if (max && sessions.countActiveForUser(user.id) >= max) {
        return res.status(429).json({ error: `You already have ${max} active sessions. End one before starting another.` });
    }

    const ticket = mintTicket({ uid: user.id, v: user.token_version, url: target });
    res.json({ redirect: `${config.proxyBaseUrl}/__portal/start?t=${encodeURIComponent(ticket)}` });
});

function safeUrl(url) {
    try {
        return normalizeUrl(url);
    } catch (_) {
        return null;
    }
}

router.delete('/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found' });
    sessions.requestEnd(s.id);
    events.record('session_end_requested', { userId: req.user.id, detail: s.id.slice(0, 8), ip: req.ip });
    res.json({ ok: true });
});

module.exports = router;
module.exports.normalizeUrl = normalizeUrl;
module.exports.isPrivateHost = isPrivateHost;
