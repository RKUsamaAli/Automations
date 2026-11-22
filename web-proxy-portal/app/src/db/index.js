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
    return db;
}

function get() {
    return db || open();
}

/** Applies pending migrations. Returns the list of applied file names. */
function migrate() {
    const conn = get();
    conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
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
            conn.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
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

module.exports = { open, get, migrate, assertMigrated, backup, close };
