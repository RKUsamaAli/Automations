'use strict';
/**
 * SQLite connection + migration runner.
 *
 * SQLite (WAL mode) is shared by the portal process and the proxy process.
 * It is a single file (shared/data/portal.db), trivial to back up, and more
 * than fast enough for the read-mostly workload of this app.
 *
 * Migrations: every *.sql file in ./migrations is applied once, in file-name
 * order, and recorded in the `schema_migrations` table.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const log = require('../lib/logger')('db');
const { newId } = require('../lib/ids');
const context = require('../lib/context');

const STATEMENT_CACHE_MAX = 500;

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
let db = null;

function open(file = config.paths.dbFile) {
    if (db) return db;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL'); // readers never block the writer
    db.pragma('synchronous = NORMAL'); // safe with WAL, much faster
    db.pragma('busy_timeout = 5000'); // wait instead of failing when another process writes
    db.pragma('foreign_keys = ON');
    // Performance (the app is read-heavy; the DB file is small):
    db.pragma('cache_size = -16000'); // 16 MB page cache per connection
    db.pragma('temp_store = MEMORY'); // sorts / GROUP BY temp tables in RAM
    db.pragma('mmap_size = 134217728'); // read through a 128 MB memory map (fewer syscalls)
    cachePreparedStatements(db);
    return db;
}

/**
 * Compiling SQL is the expensive part of a query. Services call
 * db.get().prepare(sql) freely; this makes the same SQL text reuse its
 * compiled statement (bounded LRU), so hot paths compile once.
 */
function cachePreparedStatements(conn) {
    const raw = conn.prepare.bind(conn);
    const cache = new Map();
    conn.prepare = (sql) => {
        let stmt = cache.get(sql);
        if (stmt) {
            cache.delete(sql); // move to the end (most recently used)
            cache.set(sql, stmt);
            return stmt;
        }
        stmt = raw(sql);
        if (cache.size >= STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(sql, stmt);
        return stmt;
    };
}

/**
 * INSERT with the standard columns filled in: id (GUID v7), created_at,
 * created_by, updated_at, updated_by (= acting user from the request
 * context, NULL for system). Values given in `row` win.
 * @returns {string} the new row's id
 */
function insert(table, row, { orIgnore = false } = {}) {
    const now = Date.now();
    const by = context.actor();
    const full = { id: newId(now), created_at: now, created_by: by, updated_at: now, updated_by: by, ...row };
    const cols = Object.keys(full);
    const info = get()
        .prepare(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map((c) => full[c]));
    return info.changes ? full.id : null;
}

/** SQL fragment + args every UPDATE adds:  SET ..., ${TOUCH}  with ...touch(). */
const TOUCH = 'updated_at = ?, updated_by = ?';
function touch() {
    return [Date.now(), context.actor()];
}

function get() {
    return db || open();
}

/** Applies pending migrations. Returns the list of applied file names. */
function migrate() {
    const conn = get();
    conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
    )`);
    const done = new Set(conn.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    const applied = [];
    for (const file of files) {
        if (done.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const tx = conn.transaction(() => {
            conn.exec(sql);
            insert('schema_migrations', { name: file });
        });
        tx();
        log.info(`applied migration ${file}`);
        applied.push(file);
    }
    return applied;
}

/** Throws if the schema is behind the code (process started before `migrate`). */
function assertMigrated() {
    const conn = get();
    const has = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const done = has ? new Set(conn.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)) : new Set();
    const pending = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !done.has(f));
    if (pending.length) {
        throw new Error(`Database has pending migrations (${pending.join(', ')}). Run: npm run migrate`);
    }
}

/** Online, consistent backup to `dest` (safe while the app is running). */
async function backup(dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await get().backup(dest);
    return dest;
}

function close() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = { open, get, migrate, assertMigrated, backup, close, insert, TOUCH, touch };
