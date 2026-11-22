'use strict';
/**
 * Per-request context (who is acting, which request), carried automatically
 * through async code with AsyncLocalStorage.
 *
 * The web server and the proxy engine set it once per request; services read
 * it to fill created_by / updated_by and to tag activity-log entries with the
 * request id - no need to pass the user through every function.
 *
 *   context.run({ userId, requestId, ip, source: 'web' }, next);
 *   context.actor()      // -> users.id or null (system / not signed in)
 */
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

function run(ctx, fn) {
    return store.run({ ...ctx }, fn);
}
function get() {
    return store.getStore() || null;
}
/**
 * Sets the context for the rest of the current synchronous call and the async
 * work it starts (used by the proxy engine, whose request pipeline is not a
 * single callback we can wrap).
 */
function enter(ctx) {
    store.enterWith({ ...ctx });
}

/** The acting user's id, or null for system actions. */
function actor() {
    const c = store.getStore();
    return (c && c.userId) || null;
}
/** Changes the acting user for the rest of this request (e.g. right after sign-in). */
function setActor(userId) {
    const c = store.getStore();
    if (c) c.userId = userId || null;
}

/** Audit columns for an INSERT: { id?, created_at, created_by, updated_at, updated_by }. */
function stamp(by = actor(), now = Date.now()) {
    return { created_at: now, created_by: by, updated_at: now, updated_by: by };
}

module.exports = { run, enter, get, actor, setActor, stamp };
