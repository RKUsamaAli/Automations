#!/usr/bin/env node
'use strict';
/**
 * Command line tool. On the server run it through the wrapper:
 *     sudo portal-cli <command>
 * or directly:
 *     cd /opt/proxy-portal/current && node src/cli/index.js <command>
 *
 * Commands:
 *   migrate                                   apply database migrations
 *   create-admin <username> [password]        create an admin (password generated if omitted)
 *   reset-password <username> [password]     set a new password (generated if omitted)
 *   create-user <username> [--token]          create a user with a generated password or access token
 *   list-users
 *   import-proxies <pool-name> <file> [http|socks5]   import a proxy list file (creates the pool if needed)
 *   check-proxies                             run the upstream proxy health check once
 *   backup-db <file>                          consistent copy of the database
 *   seed-examples                             add the example injected scripts (disabled)
 *   record-event <type> <info|warn|error> <detail...>
 *                                             write an activity-log entry (used by the deploy /
 *                                             rollback / backup scripts; types: deploy_*, rollback_*, backup_*, server_*)
 *
 * Every command is recorded in the activity log (source "cli") with the
 * server account that ran it (sudo user), so admins see changes made on the server too.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const [, , command, ...args] = process.argv;
const genPassword = () => crypto.randomBytes(12).toString('base64url');
const operator = () => process.env.SUDO_USER || process.env.USER || 'root';

require('../lib/system').setProcessName(command === 'record-event' ? 'deploy' : 'cli');

/** Activity-log entry for a CLI action (never fails the command). */
function audit(type, detail, extra = {}) {
    try {
        require('../services/events').record(type, { source: command === 'record-event' ? 'deploy' : 'cli', detail: `${detail} [server user: ${operator()}]`, ...extra });
    } catch (_) {
        /* the database may not exist yet (first migrate) */
    }
}

function need(value, usage) {
    if (!value) {
        console.error(`Usage: ${usage}`);
        process.exit(2);
    }
    return value;
}

async function main() {
    db.open();
    if (command !== 'migrate' && command !== 'backup-db' && command) db.assertMigrated();

    switch (command) {
        case 'migrate': {
            const applied = db.migrate();
            console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
            if (applied.length) audit('cli_migrations_applied', applied.join(', '));
            break;
        }
        case 'create-admin':
        case 'create-user': {
            const users = require('../services/users');
            const username = need(args[0], `${command} <username> [password]`);
            const wantToken = args.includes('--token');
            const password = args[1] && !args[1].startsWith('--') ? args[1] : wantToken ? null : genPassword();
            const { user, accessToken } = users.create({
                username,
                password,
                role: command === 'create-admin' ? 'admin' : 'user',
                generateToken: wantToken
            });
            console.log(`Created ${user.role} "${user.username}" (id ${user.id})`);
            audit(command === 'create-admin' ? 'cli_admin_created' : 'cli_user_created', `${user.username} (${user.role})`, { target: `user:${user.id}` });
            if (password && !args[1]) console.log(`Password:     ${password}`);
            if (accessToken) console.log(`Access code:  ${accessToken}`);
            console.log('Store these now - they are not shown again.');
            break;
        }
        case 'reset-password': {
            const users = require('../services/users');
            const username = need(args[0], 'reset-password <username> [password]');
            const row = db.get().prepare('SELECT id FROM users WHERE username = ?').get(username);
            if (!row) throw new Error(`No user named ${username}`);
            const password = args[1] || genPassword();
            users.update(row.id, { password, enabled: true });
            console.log(`Password for ${username} updated.${args[1] ? '' : `\nNew password: ${password}`}`);
            audit('cli_password_reset', username, { target: `user:${row.id}`, level: 'warn', changes: { password: ['***', 'changed'] } });
            break;
        }
        case 'list-users': {
            const users = require('../services/users');
            console.table(users.list().map((u) => ({ id: u.id, username: u.username, role: u.role, enabled: !!u.enabled, last_login: u.last_login_at ? new Date(u.last_login_at).toISOString() : '-' })));
            break;
        }
        case 'import-proxies': {
            const pools = require('../services/pools');
            const poolName = need(args[0], 'import-proxies <pool-name> <file> [http|socks5]');
            const file = need(args[1], 'import-proxies <pool-name> <file> [http|socks5]');
            const pool = pools.getPoolByName(poolName) || pools.savePool({ name: poolName });
            const result = pools.importProxies(pool.id, fs.readFileSync(path.resolve(file), 'utf8'), args[2] || 'http');
            console.log(`Pool "${pool.name}": added ${result.added}, skipped ${result.skipped} duplicates.`);
            for (const e of result.errors) console.warn('  ' + e);
            audit('cli_proxies_imported', `${pool.name}: ${result.added} added, ${result.skipped} duplicates, ${result.errors.length} invalid (${path.basename(file)})`, { target: `pool:${pool.id}` });
            break;
        }
        case 'check-proxies': {
            const summary = await require('../jobs/healthCheck').checkAll();
            console.log(summary);
            audit('cli_proxies_checked', `${summary.checked || 0} checked, ${summary.healthy || 0} online, ${summary.dead || 0} offline`);
            break;
        }
        case 'backup-db': {
            const dest = need(args[0], 'backup-db <file>');
            await db.backup(path.resolve(dest));
            // Verify the copy before anyone relies on it.
            const Database = require('better-sqlite3');
            const check = new Database(path.resolve(dest), { readonly: true });
            const result = check.pragma('integrity_check', { simple: true });
            check.close();
            if (result !== 'ok') throw new Error(`Backup integrity check failed: ${result}`);
            console.log(`Backup written to ${dest} (integrity ok)`);
            audit('backup_created', `${path.basename(dest)} (${Math.round(fs.statSync(path.resolve(dest)).size / 1024)} KB, integrity ok)`);
            break;
        }
        case 'seed-examples': {
            const scripts = require('../services/scripts');
            const dir = path.join(__dirname, '../../injected-scripts/examples');
            const existing = new Set(scripts.list().map((s) => s.name));
            for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
                const name = `Example: ${file.replace(/\.js$/, '')}`;
                if (existing.has(name)) continue;
                scripts.save({ name, domains: '*', runAt: 'document-end', loadOrder: 100, enabled: false, code: fs.readFileSync(path.join(dir, file), 'utf8') });
                console.log(`Added ${name} (disabled)`);
                audit('cli_script_added', name);
            }
            break;
        }
        case 'record-event': {
            const usage = 'record-event <type> <info|warn|error> <detail...>';
            const type = need(args[0], usage);
            const level = need(args[1], usage);
            if (!/^(deploy|rollback|backup|server)_[a-z_]{1,40}$/.test(type)) throw new Error('type must start with deploy_, rollback_, backup_ or server_');
            if (!['info', 'warn', 'error'].includes(level)) throw new Error('level must be info, warn or error');
            audit(type, args.slice(2).join(' ').slice(0, 900) || '-', { level });
            break;
        }
        default:
            console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
            process.exit(command ? 2 : 0);
    }
}

main()
    .then(() => {
        db.close();
        process.exit(0);
    })
    .catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
