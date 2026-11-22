'use strict';
/**
 * Test bootstrap: isolated temp data dir + migrated SQLite DB.
 * Must be required BEFORE any src/ module so config picks up these env vars.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
process.env.ENV_FILE = path.join(tmp, 'no-such.env');
process.env.DATA_DIR = tmp;
process.env.APP_SECRET = 'test-secret-'.padEnd(64, 'x');
process.env.APP_DOMAIN = 'portal.test';
process.env.PROXY_DOMAIN = 'browse.test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.WEB_PORT = '0';
process.env.HEALTHCHECK_ENABLED = 'false';

const db = require('../src/db');
db.open();
db.migrate();

module.exports = { tmp, db };
