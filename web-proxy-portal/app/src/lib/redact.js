'use strict';
/**
 * Redaction - nothing secret ever reaches a log line or an error report.
 *
 *   redactUrl('https://u:p@site.com/login?password=x&q=shoes')
 *     -> 'https://site.com/login?password=[redacted]&q=shoes'
 *   redactObject({ username: 'a', password: 'x' }) -> { username: 'a', password: '[redacted]' }
 *   safeHeaders(req.headers) -> headers without cookies / auth / CSRF
 */

// Names that hold secrets, in objects AND URL query strings.
const SENSITIVE = /pass|pwd|secret|token|^auth|authorization|apikey|api_key|access_key|^key$|ticket|session|^sid$|signature|otp|credential|cookie|csrf/i;
// Extra names that are secret only as URL query parameters (?t=<ticket>, ?code=<oauth code>, ?sig=).
// NOT applied to object keys: e.g. a trail step's `t` is its timestamp.
const SENSITIVE_PARAM = /^t$|^code$|^sig$/i;
const MAX_URL = 600;
const HIDDEN_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-csrf-token']);

function redactUrl(raw) {
    if (!raw) return raw;
    const s = String(raw);
    let u;
    try {
        u = new URL(s, 'http://relative.invalid');
    } catch (_) {
        return s.slice(0, MAX_URL);
    }
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) {
        if (SENSITIVE.test(key) || SENSITIVE_PARAM.test(key)) u.searchParams.set(key, '[redacted]');
    }
    let out = u.toString();
    if (out.startsWith('http://relative.invalid')) out = out.slice('http://relative.invalid'.length);
    // Proxy URLs carry a credentials-like 32-char session id: shorten it.
    out = out.replace(/\/([a-z0-9]{32})(?=[/!])/gi, (_, sid) => `/${sid.slice(0, 8)}…`);
    return out.length > MAX_URL ? out.slice(0, MAX_URL) + '…' : out;
}

function redactObject(value, depth = 0) {
    if (value == null || depth > 4) return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactObject(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SENSITIVE.test(k) ? '[redacted]' : redactObject(v, depth + 1);
        }
        return out;
    }
    if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
    return value;
}

function safeHeaders(headers = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (HIDDEN_HEADERS.has(k.toLowerCase())) continue;
        out[k] = k.toLowerCase() === 'referer' ? redactUrl(v) : String(v).slice(0, 300);
    }
    return out;
}

/** Masks credentials in free text such as error messages ("http://user:pass@1.2.3.4"). */
function redactText(text) {
    return String(text ?? '')
        .replace(/(\w+:\/\/)([^\s:@/]+):([^\s@/]+)@/g, '$1$2:***@')
        .slice(0, 4000);
}

module.exports = { redactUrl, redactObject, safeHeaders, redactText, SENSITIVE };
