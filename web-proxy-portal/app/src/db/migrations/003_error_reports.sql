-- =============================================================================
-- 003 - error reports ("what happened before it broke")
--
-- Successful requests are NOT stored. Each process keeps a short in-memory
-- trail of recent steps per user/session; when something fails, that trail is
-- saved here together with the error, so it can be reproduced and fixed.
-- Additive only (new table).
-- =============================================================================
CREATE TABLE error_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ref           TEXT NOT NULL UNIQUE,              -- shown to the user, e.g. E-7K2P9Q
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    occurrences   INTEGER NOT NULL DEFAULT 1,        -- same error, same user/session, shortly after
    source        TEXT NOT NULL,                     -- web | proxy | client
    kind          TEXT NOT NULL,                     -- page_load_failed, server_exception, client_js, api_error, site_error ...
    severity      TEXT NOT NULL DEFAULT 'error',     -- error | warning
    fingerprint   TEXT NOT NULL,                     -- groups identical errors
    message       TEXT NOT NULL,
    stack         TEXT,
    user_id       INTEGER,
    session_id    TEXT,                              -- browsing session (proxy)
    request_id    TEXT,                              -- X-Request-Id (matches nginx/app logs)
    release       TEXT,
    url           TEXT,                              -- redacted
    dest_host     TEXT,
    proxy_id      INTEGER,
    pool_id       INTEGER,
    client_ip     TEXT,
    user_agent    TEXT,
    context       TEXT,                              -- JSON: request, upstream, timings ...
    breadcrumbs   TEXT,                              -- JSON: the steps before the error
    resolved      INTEGER NOT NULL DEFAULT 0,
    resolved_at   INTEGER,
    resolved_by   INTEGER,
    note          TEXT
);
CREATE INDEX idx_errors_created ON error_reports(created_at);
CREATE INDEX idx_errors_fingerprint ON error_reports(fingerprint);
CREATE INDEX idx_errors_user ON error_reports(user_id);
CREATE INDEX idx_errors_open ON error_reports(resolved, last_seen_at);
