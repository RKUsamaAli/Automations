'use strict';
/**
 * Portal users. A user logs in with username + password, OR with a personal
 * access token (handy to hand out to a group: "open the link, paste the code").
 */
const db = require('../db');
const { hashPassword, verifyPassword, randomToken, sha256 } = require('../lib/crypto');
const TtlCache = require('../lib/ttlCache');
const { newId, idOrNull } = require('../lib/ids');
const paging = require('../lib/paging');

const PUBLIC_FIELDS = `id, username, email, role, enabled, pending, pool_id, rate_limit_rpm, bandwidth_limit_mb_day,
    token_version, note, created_at, created_by, updated_at, updated_by, last_login_at, timezone,
    (password_hash IS NOT NULL) AS has_password, (access_token_hash IS NOT NULL) AS has_token`;

// Short cache used by the proxy engine on every request.
const cache = new TtlCache(3000); // disabled users / logouts take effect within ~3 s

function getById(id) {
    return db.get().prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id) || null;
}

function getByIdCached(id) {
    return cache.get(id, () => getById(id));
}

/**
 * Cached user for a login/proxy cookie carrying token_version `v`.
 * With several processes (WEB_INSTANCES>1, PROXY_WORKERS>0) another process
 * may have just bumped token_version (password change, logout everywhere), so
 * on a mismatch we re-read the database before deciding. Without this, one
 * instance accepts the new cookie and another rejects it -> redirect loops.
 */
function getForToken(id, v) {
    const cached = getByIdCached(id);
    if (cached && cached.token_version === v) return cached;
    const fresh = getById(id);
    cache.set(id, fresh);
    return fresh;
}

function list() {
    return db.get().prepare(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY username`).all();
}

/**
 * One lazy-loaded batch of users (A-Z). Approved users only unless
 * `pending` is set; `q` searches username / email.
 */
function page({ q = '', pending = false } = {}, { cursor = null, limit } = {}) {
    const n = paging.limitOf(limit);
    const where = [pending ? 'pending = 1' : 'pending = 0'];
    const args = [];
    if (q) {
        const like = `%${String(q).slice(0, 100)}%`;
        where.push('(username LIKE ? OR email LIKE ?)');
        args.push(like, like);
    }
    const after = paging.decodeCursor(cursor);
    if (after) {
        where.push('(username COLLATE NOCASE > ? OR (username COLLATE NOCASE = ? AND id > ?))');
        args.push(String(after[0]), String(after[0]), String(after[1]));
    }
    args.push(n + 1);
    const rows = db
        .get()
        .prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE ${where.join(' AND ')} ORDER BY username COLLATE NOCASE, id LIMIT ?`)
        .all(...args);
    return paging.toPage(rows, n, (r) => [r.username, r.id]);
}

/** Totals over every user (the summary strip on Admin -> Users). */
function pageSummary({ q = '' } = {}) {
    const args = [];
    let where = '';
    if (q) {
        const like = `%${String(q).slice(0, 100)}%`;
        where = 'WHERE (username LIKE ? OR email LIKE ?)';
        args.push(like, like);
    }
    const r = db
        .get()
        .prepare(
            `SELECT COUNT(*) AS total, SUM(CASE WHEN pending = 0 THEN 1 ELSE 0 END) AS approved,
                    SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
                    SUM(CASE WHEN enabled = 0 AND pending = 0 THEN 1 ELSE 0 END) AS disabled,
                    SUM(pending) AS pending, SUM(CASE WHEN last_login_at > ? THEN 1 ELSE 0 END) AS active7d
             FROM users ${where}`
        )
        .get(Date.now() - 7 * 86400000, ...args);
    return { total: r.total, approved: r.approved || 0, admins: r.admins || 0, disabled: r.disabled || 0, pending: r.pending || 0, active7d: r.active7d || 0 };
}

/**
 * Remembers the user's browser time zone (sent as X-Timezone). Only writes
 * when it changed, so normal requests cost nothing.
 */
function setTimezone(id, tz) {
    const changed = db.get().prepare(`UPDATE users SET timezone = ?, ${db.TOUCH} WHERE id = ? AND timezone IS NOT ?`).run(tz, ...db.touch(), id, tz).changes;
    if (changed) cache.delete(id);
    return changed > 0;
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
    const p = String(password || '');
    if (p.length < 8) throw new Error('Password must be at least 8 characters');
    if (p.length > 200) throw new Error('Password is too long');
}

function validateEmail(email) {
    if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(email))) throw new Error('Enter a valid e-mail address');
}

const optInt = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, Math.floor(Number(v)) || 0));

/**
 * @returns {{ user: object, accessToken: string|null }} accessToken is shown ONCE.
 */
function create({ username, password, email = null, role = 'user', pending = false, generateToken = false, poolId = null, rateLimitRpm = null, bandwidthLimitMbDay = null, note = null, selfCreated = false }) {
    validateUsername(username);
    validateEmail(email);
    if (!password && !generateToken) throw new Error('Provide a password or generate an access token');
    if (password) validatePassword(password);
    if (!['admin', 'user'].includes(role)) throw new Error('Invalid role');
    const accessToken = generateToken ? randomToken(18) : null;
    try {
        const newUserId = newId();
        db.insert('users', {
            id: newUserId,
            username,
            email: email ? String(email).trim().toLowerCase() : null,
            pending: pending ? 1 : 0,
            password_hash: password ? hashPassword(password) : null,
            access_token_hash: accessToken ? sha256(accessToken) : null,
            role,
            pool_id: idOrNull(poolId),
            rate_limit_rpm: optInt(rateLimitRpm),
            bandwidth_limit_mb_day: optInt(bandwidthLimitMbDay),
            note: note || null,
            // self sign-up: the new user created their own account
            ...(selfCreated ? { created_by: newUserId, updated_by: newUserId } : {})
        });
        return { user: getById(newUserId), accessToken };
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
    if (patch.poolId !== undefined) set('pool_id', idOrNull(patch.poolId));
    if (patch.rateLimitRpm !== undefined) set('rate_limit_rpm', optInt(patch.rateLimitRpm));
    if (patch.bandwidthLimitMbDay !== undefined) set('bandwidth_limit_mb_day', optInt(patch.bandwidthLimitMbDay));
    if (patch.note !== undefined) set('note', patch.note || null);
    if (patch.email !== undefined) {
        validateEmail(patch.email);
        set('email', patch.email ? String(patch.email).trim().toLowerCase() : null);
    }
    if (patch.pending !== undefined) set('pending', patch.pending ? 1 : 0);
    if (patch.password) {
        validatePassword(patch.password);
        set('password_hash', hashPassword(patch.password));
    }
    // Disabling a user or changing their password logs them out everywhere.
    if (patch.enabled === false || patch.password || patch.logoutEverywhere) {
        fields.push('token_version = token_version + 1');
    }
    if (fields.length) {
        args.push(...db.touch(), id);
        db.get().prepare(`UPDATE users SET ${fields.join(', ')}, ${db.TOUCH} WHERE id = ?`).run(...args);
    }
    cache.delete(id);
    return getById(id);
}

/** Creates a new access token (replacing the old one). Returns the plain token once. */
function regenerateToken(id) {
    const token = randomToken(18);
    db.get().prepare(`UPDATE users SET access_token_hash = ?, ${db.TOUCH} WHERE id = ?`).run(sha256(token), ...db.touch(), id);
    cache.delete(id);
    return token;
}

function revokeToken(id) {
    db.get().prepare(`UPDATE users SET access_token_hash = NULL, ${db.TOUCH} WHERE id = ?`).run(...db.touch(), id);
    cache.delete(id);
}

function remove(id) {
    db.get().prepare('DELETE FROM users WHERE id = ?').run(id);
    cache.delete(id);
}

function countAdmins() {
    return db.get().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1").get().n;
}

/**
 * Checks a username + password.
 * @returns {{ user: object } | { error: 'invalid' | 'pending' | 'disabled' }}
 * Always runs one scrypt hash, so response time does not reveal whether the user exists.
 */
function authenticatePassword(username, password) {
    const row = db.get().prepare('SELECT id, password_hash, enabled, pending FROM users WHERE username = ?').get(String(username || ''));
    if (!row || !row.password_hash) {
        verifyPassword(String(password), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
        return { error: 'invalid' };
    }
    if (!verifyPassword(password, row.password_hash)) return { error: 'invalid' };
    return finishLogin(row);
}

/** Checks an access code. Same return shape as authenticatePassword. */
function authenticateToken(token) {
    if (!token || String(token).length < 10) return { error: 'invalid' };
    const row = db.get().prepare('SELECT id, enabled, pending FROM users WHERE access_token_hash = ?').get(sha256(String(token).trim()));
    if (!row) return { error: 'invalid' };
    return finishLogin(row);
}

function finishLogin(row) {
    if (row.pending) return { error: 'pending' };
    if (!row.enabled) return { error: 'disabled' };
    return { user: markLogin(row.id) };
}

/** Self-registration from the sign-up page. */
function register({ username, email, password, needsApproval }) {
    validatePassword(password);
    return create({ username, email, password, role: 'user', pending: !!needsApproval, selfCreated: true }).user;
}

function approve(id) {
    db.get().prepare(`UPDATE users SET pending = 0, enabled = 1, ${db.TOUCH} WHERE id = ?`).run(...db.touch(), id);
    cache.delete(id);
    return getById(id);
}

function countPending() {
    return db.get().prepare('SELECT COUNT(*) AS n FROM users WHERE pending = 1').get().n;
}

/** Users change their own password (needs the current one). */
function changeOwnPassword(id, currentPassword, newPassword) {
    const row = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(id);
    if (!row) throw new Error('User not found');
    if (row.password_hash && !verifyPassword(currentPassword, row.password_hash)) throw new Error('Current password is wrong');
    return update(id, { password: newPassword });
}

function markLogin(id) {
    db.get().prepare(`UPDATE users SET last_login_at = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(Date.now(), Date.now(), id, id); // the user signed themselves in
    return getById(id);
}

module.exports = {
    setTimezone,
    page,
    pageSummary,
    getById,
    getByIdCached,
    getForToken,
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
    register,
    approve,
    countPending,
    changeOwnPassword,
    clearCache: () => cache.clear()
};
