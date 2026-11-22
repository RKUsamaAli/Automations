'use strict';
/**
 * Security primitives - all built on Node's crypto module (no extra deps).
 *
 *  - hashPassword / verifyPassword : scrypt password hashing
 *  - randomToken / sha256          : access tokens (only the hash is stored)
 *  - sign / verify                 : compact HMAC-signed tokens used for
 *                                    login cookies and one-time "tickets"
 */
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Passwords (scrypt). Stored format: scrypt$N$r$p$saltB64$hashB64
// ---------------------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p)
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Random tokens
// ---------------------------------------------------------------------------
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---------------------------------------------------------------------------
// Signed tokens: base64url(JSON payload) + "." + base64url(HMAC)
// Each "purpose" (login cookie, proxy cookie, ticket) gets its own derived key
// so a token minted for one purpose can never be replayed as another.
// ---------------------------------------------------------------------------
const keyCache = new Map();
function deriveKey(secret, purpose) {
    const cacheKey = purpose + '|' + secret;
    if (!keyCache.has(cacheKey)) {
        keyCache.set(cacheKey, crypto.createHmac('sha256', secret).update('portal-key:' + purpose).digest());
    }
    return keyCache.get(cacheKey);
}

/**
 * @param {object} payload - must contain `exp` (unix ms) for expiry checks
 * @param {string} secret  - config.appSecret
 * @param {string} purpose - e.g. 'login', 'proxy', 'ticket'
 */
function sign(payload, secret, purpose) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', deriveKey(secret, purpose)).update(body).digest('base64url');
    return `${body}.${mac}`;
}

/** @returns {object|null} payload when the signature is valid and not expired */
function verify(token, secret, purpose) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = crypto.createHmac('sha256', deriveKey(secret, purpose)).update(body).digest();
    if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, sign, verify };
