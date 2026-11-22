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
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const [, , command, ...args] = process.argv;
const genPassword = () => crypto.randomBytes(12).toString('base64url');

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
            break;
        }
        case 'check-proxies': {
            const summary = await require('../jobs/healthCheck').checkAll();
            console.log(summary);
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
            }
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
