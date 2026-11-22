'use strict';
/**
 * JSON Web Tokens (RFC 7519), HS256, no dependencies.
 *
 * Each token kind is signed with its OWN key derived from APP_SECRET, so an
 * access token can never be replayed as an identity token (or the other way
 * round) even if someone edits its "typ" claim.
 *
 *   const t = jwt.sign({ sub: userId, ... }, { kind: 'access', ttlSec: 300 });
 *   const claims = jwt.verify(t, { kind: 'access' });   // null when invalid / expired
 *   jwt.inspect(t, { kind: 'access' })                    // { claims, expired } (signature checked)
 */
const crypto = require('crypto');
const config = require('../config');
const { deriveKey } = require('./crypto');
const { newId } = require('./ids');

const ISSUER = 'web-proxy-portal';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const HEADER = b64({ alg: 'HS256', typ: 'JWT' });
const CLOCK_SKEW_SEC = 30;

function keyFor(kind) {
    return deriveKey(config.appSecret, 'jwt:' + kind);
}

/**
 * @param {object} claims    custom claims (sub, name, role ...)
 * @param {object} opts      { kind: 'identity'|'access'|'proxy', ttlSec, audience }
 * @returns {{ token: string, claims: object }}
 */
function sign(claims, { kind, ttlSec, audience = config.appBaseUrl }) {
    const now = Math.floor(Date.now() / 1000);
    const full = { iss: ISSUER, aud: audience, typ: kind, iat: now, nbf: now - CLOCK_SKEW_SEC, exp: now + Math.floor(ttlSec), jti: newId(), ...claims };
    const body = `${HEADER}.${b64(full)}`;
    const sig = crypto.createHmac('sha256', keyFor(kind)).update(body).digest('base64url');
    return { token: `${body}.${sig}`, claims: full };
}

/** Checks signature, issuer, kind and audience. Returns { claims, expired } or null. */
function inspect(token, { kind, audience = config.appBaseUrl }) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== HEADER) return null; // only our exact header (no alg=none tricks)
    const expected = crypto.createHmac('sha256', keyFor(kind)).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let claims;
    try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!claims || claims.iss !== ISSUER || claims.typ !== kind || claims.aud !== audience) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.nbf === 'number' && claims.nbf > now + CLOCK_SKEW_SEC) return null;
    return { claims, expired: typeof claims.exp !== 'number' || claims.exp <= now };
}

/** Valid and not expired -> claims, else null. */
function verify(token, opts) {
    const r = inspect(token, opts);
    return r && !r.expired ? r.claims : null;
}

module.exports = { sign, verify, inspect, ISSUER };
