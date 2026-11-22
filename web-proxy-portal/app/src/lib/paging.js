'use strict';
/**
 * Keyset ("cursor") pagination helpers, used by every long admin list.
 *
 * Why cursors instead of OFFSET: new rows keep arriving (request log,
 * events...). With OFFSET, rows shift between pages and appear twice or get
 * skipped; and OFFSET 50000 has to walk 50000 rows. A cursor says "continue
 * after this row" - stable and equally fast on every page.
 *
 * Every paged endpoint answers:
 *   { items: [...], nextCursor: "..." | null, summary?: {...} }
 * `summary` (totals over the WHOLE filtered set) is only computed for the
 * first page - the browser keeps it while it loads more rows on scroll.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitOf(value) {
    const n = Number(value);
    return Math.min(Math.max(Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** Opaque cursor <-> values (base64url JSON array). */
function encodeCursor(values) {
    return Buffer.from(JSON.stringify(values)).toString('base64url');
}
function decodeCursor(cursor) {
    if (!cursor) return null;
    try {
        const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        return Array.isArray(v) ? v : null;
    } catch (_) {
        return null;
    }
}

/**
 * Turns `limit + 1` fetched rows into a page.
 * @param {object[]} rows       fetched with LIMIT limit+1
 * @param {number} limit
 * @param {(row) => any[]} keyOf values the next page continues after
 */
function toPage(rows, limit, keyOf) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore && items.length ? encodeCursor(keyOf(items[items.length - 1])) : null };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, limitOf, encodeCursor, decodeCursor, toPage };
