'use strict';
/**
 * Portal users. A user logs in with username + password, OR with a personal
 * access token (handy to hand out to a group: "open the link, paste the code").
 */
const db = require('../db');
const { hashPassword, verifyPassword, randomToken, sha256 } = require('../lib/crypto');
const TtlCache = require('../lib/ttlCache');

const PUBLIC_FIELDS = `id, username, role, enabled, pool_id, rate_limit_rpm, bandwidth_limit_mb_day,
    token_version, note, created_at, last_login_at,
    (password_hash IS NOT NULL) AS has_password, (access_token_hash IS NOT NULL) AS has_token`;

// Short cache used by the proxy engine on every request.
const cache = new TtlCache(15000);

function getById(id) {
    return db.get().prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id) || null;
}

function getByIdCached(id) {
    return cache.get(id, () => getById(id));
}

function list() {
    return db.get().prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY username`).all();
}

function count() {
    return db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function validateUsername(username) {
    if (!/^[a-zA-Z0-9._@-]{3,64}$/.test(String(username || ''))) {
        throw new Error('Username must be 3-64 characters: letters, digits, . _ @ -');
    }
}

function validatePassword(password) {
    if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
}

const optInt = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, parseInt(v, 10) || 0));

/**
 * @returns {{ user: object, accessToken: string|null }} accessToken is shown ONCE.
 */
function create({ username, password, role = 'user', generateToken = false, poolId = null, rateLimitRpm = null, bandwidthLimitMbDay = null, note = null }) {
    validateUsername(username);
    if (!password && !generateToken) throw new Error('Provide a password or generate an access token');
    if (password) validatePassword(password);
    if (!['admin', 'user'].includes(role)) throw new Error('Invalid role');
    const accessToken = generateToken ? randomToken(18) : null;
    try {
        const info = db
            .get()
            .prepare(
                `INSERT INTO users (username, password_hash, access_token_hash, role, pool_id, rate_limit_rpm, bandwidth_limit_mb_day, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                username,
                password ? hashPassword(password) : null,
                accessToken ? sha256(accessToken) : null,
                role,
                poolId || null,
                optInt(rateLimitRpm),
                optInt(bandwidthLimitMbDay),
                note || null,
                Date.now()
            );
        return { user: getById(info.lastInsertRowid), accessToken };
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) throw new Error('Username already exists');
        throw e;
    }
}

function update(id, patch) {
    const user = getById(id);
    if (!user) throw new Error('User not found');
    const fields = [];
    const args = [];
    const set = (col, val) => {
        fields.push(`${col} = ?`);
        args.push(val);
    };
    if (patch.role !== undefined) {
        if (!['admin', 'user'].includes(patch.role)) throw new Error('Invalid role');
        set('role', patch.role);
    }
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.poolId !== undefined) set('pool_id', patch.poolId || null);
    if (patch.rateLimitRpm !== undefined) set('rate_limit_rpm', optInt(patch.rateLimitRpm));
    if (patch.bandwidthLimitMbDay !== undefined) set('bandwidth_limit_mb_day', optInt(patch.bandwidthLimitMbDay));
    if (patch.note !== undefined) set('note', patch.note || null);
    if (patch.password) {
        validatePassword(patch.password);
        set('password_hash', hashPassword(patch.password));
    }
    // Disabling a user or changing their password logs them out everywhere.
    if (patch.enabled === false || patch.password || patch.logoutEverywhere) {
        fields.push('token_version = token_version + 1');
    }
    if (fields.length) {
        args.push(id);
        db.get().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...args);
    }
    cache.delete(id);
    return getById(id);
}

/** Creates a new access token (replacing the old one). Returns the plain token once. */
function regenerateToken(id) {
    const token = randomToken(18);
    db.get().prepare('UPDATE users SET access_token_hash = ? WHERE id = ?').run(sha256(token), id);
    cache.delete(id);
    return token;
}

function revokeToken(id) {
    db.get().prepare('UPDATE users SET access_token_hash = NULL WHERE id = ?').run(id);
    cache.delete(id);
}

function remove(id) {
    db.get().prepare('DELETE FROM users WHERE id = ?').run(id);
    cache.delete(id);
}

function countAdmins() {
    return db.get().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1").get().n;
}

/** @returns user or null. Constant-ish time: always runs a hash when the user is unknown. */
function authenticatePassword(username, password) {
    const row = db.get().prepare('SELECT id, password_hash, enabled FROM users WHERE username = ?').get(String(username || ''));
    if (!row || !row.password_hash) {
        verifyPassword(String(password), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
        return null;
    }
    if (!verifyPassword(password, row.password_hash) || !row.enabled) return null;
    return markLogin(row.id);
}

function authenticateToken(token) {
    if (!token || String(token).length < 10) return null;
    const row = db.get().prepare('SELECT id, enabled FROM users WHERE access_token_hash = ?').get(sha256(String(token).trim()));
    if (!row || !row.enabled) return null;
    return markLogin(row.id);
}

function markLogin(id) {
    db.get().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
    return getById(id);
}

module.exports = {
    getById,
    getByIdCached,
    list,
    count,
    create,
    update,
    regenerateToken,
    revokeToken,
    remove,
    countAdmins,
    authenticatePassword,
    authenticateToken,
    clearCache: () => cache.clear()
};
