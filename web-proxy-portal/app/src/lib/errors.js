'use strict';
/**
 * Tells real BUGS apart from expected problems.
 *
 * Services throw plain Errors for things the user can fix ("Username already
 * exists", "Invalid domain pattern") - those become a 400 with the message and
 * are NOT error reports. Programming / infrastructure failures (TypeError,
 * database errors, ...) must never be shown as a "validation" message: they
 * become a 500, an error report with the steps that led to it, and a
 * reference for the user.
 */
function isBug(err) {
    if (!err) return false;
    if (err.expose === false || err.isBug) return true;
    if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError || err instanceof SyntaxError) {
        // JSON body parse errors are client mistakes, handled separately by express
        return err.type !== 'entity.parse.failed';
    }
    const code = String(err.code || '');
    return code.startsWith('SQLITE_') || code === 'ERR_ASSERTION' || code === 'ENOSPC' || code === 'EACCES';
}

module.exports = { isBug };
