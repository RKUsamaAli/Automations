'use strict';
/**
 * Loads the vendored Rammerhead engine.
 *
 * Rammerhead is NOT installed from npm. deploy.sh clones the official
 * repository (binary-person/rammerhead) at the commit pinned in
 * app/rammerhead.lock, runs `npm install` + `npm run build` in it, and links
 * it to <release>/vendor/rammerhead. This module resolves everything from
 * there, including Rammerhead's own dependencies (sticky-session-custom ...).
 *
 * Override the location with RAMMERHEAD_DIR in .env (useful for local dev).
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const config = require('../config');

const dir = config.proxy.rammerheadDir;
const pkg = path.join(dir, 'package.json');

if (!fs.existsSync(pkg)) {
    throw new Error(
        `Rammerhead not found at ${dir}. Run deploy/deploy.sh on the server, or for local development:\n` +
            `  git clone https://github.com/binary-person/rammerhead.git ${dir} && cd ${dir} && npm install && npm run build`
    );
}
if (!fs.existsSync(path.join(dir, 'src/client/hammerhead.min.js'))) {
    throw new Error(`Rammerhead at ${dir} is not built. Run: cd ${dir} && npm run build`);
}

// require() that resolves modules relative to the Rammerhead checkout.
const rhRequire = createRequire(pkg);

module.exports = {
    dir,
    rhRequire,
    ...rhRequire('./src/index.js'), // RammerheadProxy, RammerheadSession, RammerheadSessionFileCache, StrShuffler, generateId ...
    getSessionId: rhRequire('./src/util/getSessionId.js'),
    cacheTag: rhRequire('./src/util/deployCacheTag.js')
};
