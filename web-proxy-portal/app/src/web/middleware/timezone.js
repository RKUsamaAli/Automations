'use strict';
/**
 * Viewer time zone for this request -> req.tz (IANA name, always valid).
 *
 * Source, in order:
 *   1. `X-Timezone` header - sent by every fetch from the portal pages
 *      (Intl.DateTimeFormat().resolvedOptions().timeZone in the browser)
 *   2. `?tz=` query parameter - for plain links such as CSV downloads
 *   3. the user's last known zone (users.timezone)
 *   4. UTC
 *
 * A signed-in user's zone is saved when it changes, so the proxy engine (which
 * never sees these headers) can apply the daily traffic limit at the user's
 * own midnight.
 */
const tzlib = require('../../lib/timezone');
const users = require('../../services/users');
const log = require('../../lib/logger')('timezone');

function timezone(req, res, next) {
    const sent = req.get('x-timezone') || (typeof req.query.tz === 'string' ? req.query.tz : '');
    const valid = tzlib.isValid(sent) ? sent : null;
    req.tz = valid || (req.user && tzlib.isValid(req.user.timezone) ? req.user.timezone : tzlib.DEFAULT_TZ);
    if (valid && req.user && req.user.timezone !== valid) {
        try {
            users.setTimezone(req.user.id, valid);
            req.user.timezone = valid;
        } catch (e) {
            log.warn('could not save time zone', e);
        }
    }
    res.set('X-Timezone-Used', req.tz); // handy when debugging "wrong day" reports
    next();
}

module.exports = { timezone };
