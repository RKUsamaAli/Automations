'use strict';
/**
 * Parses Rammerhead proxy URLs back into the real destination URL.
 *
 *   https://browse.example.com/<32-char session id>[!flags]/<destination>[!v<cachetag>]
 *
 * <destination> may be "shuffled" (Rammerhead's URL obfuscation, prefix _rhs)
 * - we undo that with the session's shuffle dictionary.
 * Flags are hammerhead resource markers, e.g. "!i" = iframe, "!s" = script, "!a" = ajax.
 */

/**
 * @param {string} urlOrPath   req.url or a Referer header
 * @param {(id:string) => object|undefined} getSession  returns the RammerheadSession
 * @param {object} rh          the loaded rammerhead module (StrShuffler, cacheTag)
 * @returns {{ sid:string, flags:string, destUrl:string, host:string } | null}
 */
function parseProxied(urlOrPath, getSession, rh) {
    if (!urlOrPath) return null;
    let p = String(urlOrPath).replace(/^[a-z]+:\/\/[^/]+/i, ''); // drop origin
    if (rh.cacheTag) p = rh.cacheTag.strip(p);
    const m = p.match(/^\/([a-z0-9]{32})(![^/]*)?\/(.*)$/i);
    if (!m) return null;
    const [, sid, flags = '', rest] = m;
    let dest = rest;
    const session = getSession(sid);
    if (session && session.shuffleDict && rh.StrShuffler) {
        dest = new rh.StrShuffler(session.shuffleDict).unshuffle(dest);
    }
    try {
        const u = new URL(dest);
        if (!/^(https?|wss?):$/.test(u.protocol)) return null;
        return { sid, flags: flags.slice(1), destUrl: u.toString(), host: u.hostname.toLowerCase() };
    } catch (_) {
        return null;
    }
}

module.exports = { parseProxied };
