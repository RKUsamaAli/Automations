'use strict';
/**
 * Helpers for the activity log.
 *
 *   diff(before, after, ['role', 'enabled'])  ->  { role: ['user', 'admin'] }
 *   describe(changes)                          ->  "role user -> admin"
 *
 * Fields named like secrets (password, token, code, key...) are masked:
 * the log says THAT they changed, never their value.
 */
const SECRET = /pass|token|secret|code$|key/i;

function show(v) {
    if (v === null || v === undefined || v === '') return '(empty)';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v).length > 60 ? String(v).slice(0, 57) + '...' : String(v);
}

function diff(before, after, fields) {
    const out = {};
    for (const f of fields) {
        const a = before ? before[f] : undefined;
        const b = after ? after[f] : undefined;
        const norm = (v) => (v === undefined || v === '' ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
        if (String(norm(a)) === String(norm(b))) continue;
        out[f] = SECRET.test(f) ? ['***', 'changed'] : [a === undefined ? null : a, b === undefined ? null : b];
    }
    return out;
}

function describe(changes) {
    return Object.entries(changes || {})
        .map(([f, [a, b]]) => (a === '***' ? `${f} changed` : `${f} ${show(a)} -> ${show(b)}`))
        .join(', ');
}

module.exports = { diff, describe };
