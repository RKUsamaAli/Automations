'use strict';
/**
 * Recent searches per user ("Recent searches" under the Browse search box).
 * Keeps the newest KEEP distinct queries per user.
 */
const db = require('../db');

const KEEP = 50;
const clean = (q) => String(q || '').replace(/\s+/g, ' ').trim().slice(0, 300);

function record(userId, query) {
    const q = clean(query);
    if (!userId || !q) return;
    const key = q.toLowerCase();
    const now = Date.now();
    const d = db.get();
    const updated = d
        .prepare(`UPDATE search_history SET query = ?, searched_at = ?, count = count + 1, ${db.TOUCH} WHERE user_id = ? AND query_key = ?`)
        .run(q, now, ...db.touch(), userId, key);
    if (!updated.changes) db.insert('search_history', { user_id: userId, query: q, query_key: key, searched_at: now }, { orIgnore: true });
    // trim old entries now and then
    if (Math.random() < 0.1) {
        d.prepare(
            `DELETE FROM search_history WHERE user_id = ? AND id NOT IN
               (SELECT id FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT ${KEEP})`
        ).run(userId, userId);
    }
}

/** Newest first; optional filter (contains, prefix matches first). */
function list(userId, { q = '', limit = 8 } = {}) {
    const f = clean(q).toLowerCase().slice(0, 100);
    const esc = f.replace(/[\\%_]/g, (c) => '\\' + c);
    return db
        .get()
        .prepare(
            `SELECT id, query, searched_at AS searchedAt, count FROM search_history
             WHERE user_id = ? AND query_key LIKE ? ESCAPE '\\'
             ORDER BY (query_key LIKE ? ESCAPE '\\') DESC, searched_at DESC LIMIT ?`
        )
        .all(userId, `%${esc}%`, `${esc}%`, Math.min(Math.max(1, Number(limit) || 8), 20));
}

function remove(userId, id) {
    return db.get().prepare('DELETE FROM search_history WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0;
}

function clear(userId) {
    return db.get().prepare('DELETE FROM search_history WHERE user_id = ?').run(userId).changes;
}

module.exports = { record, list, remove, clear };
