-- =============================================================================
-- 001_init.sql - initial schema
--
-- RULE FOR FUTURE MIGRATIONS: keep them ADDITIVE (new tables / new nullable
-- columns). That way the previous release still works against the new schema
-- and `rollback.sh` does not need a database restore in normal cases.
-- =============================================================================

-- Portal users (admins and normal users) --------------------------------------
CREATE TABLE users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash         TEXT,                      -- scrypt hash, NULL = token-only user
    access_token_hash     TEXT UNIQUE,               -- sha256 of access token, NULL = none
    role                  TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    enabled               INTEGER NOT NULL DEFAULT 1,
    pool_id               INTEGER REFERENCES proxy_pools(id) ON DELETE SET NULL, -- per-user pool override
    rate_limit_rpm        INTEGER,                   -- NULL = use global default
    bandwidth_limit_mb_day INTEGER,                  -- NULL = use global default, 0 = unlimited
    token_version         INTEGER NOT NULL DEFAULT 1, -- bump to log the user out everywhere
    note                  TEXT,
    created_at            INTEGER NOT NULL,
    last_login_at         INTEGER
);

-- Upstream proxy pools (e.g. "US residential", "UK ISP") ----------------------
CREATE TABLE proxy_pools (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    country     TEXT,                                -- free text tag, e.g. US
    type        TEXT NOT NULL DEFAULT 'datacenter' CHECK (type IN ('residential', 'isp', 'datacenter', 'mobile', 'other')),
    is_default  INTEGER NOT NULL DEFAULT 0,          -- used when no site/user rule matches
    description TEXT,
    created_at  INTEGER NOT NULL
);

-- Individual upstream proxies -------------------------------------------------
CREATE TABLE proxies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id         INTEGER NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
    protocol        TEXT NOT NULL CHECK (protocol IN ('http', 'socks5')),
    host            TEXT NOT NULL,
    port            INTEGER NOT NULL,
    username        TEXT,
    password        TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'slow', 'dead')),
    latency_ms      INTEGER,
    fail_count      INTEGER NOT NULL DEFAULT 0,
    last_checked_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE (pool_id, protocol, host, port, username)
);
CREATE INDEX idx_proxies_pool ON proxies(pool_id);

-- Target sites configured by the admin (shown as tiles on the landing page) ---
CREATE TABLE sites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    start_url   TEXT NOT NULL,
    domains     TEXT NOT NULL,                       -- comma separated patterns, e.g. "*.example.com"
    pool_id     INTEGER REFERENCES proxy_pools(id) ON DELETE SET NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    show_on_landing INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

-- Custom JavaScript injected into proxied pages --------------------------------
CREATE TABLE scripts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    domains     TEXT NOT NULL DEFAULT '*',           -- patterns this script runs on
    run_at      TEXT NOT NULL DEFAULT 'document-end' CHECK (run_at IN ('document-start', 'document-end', 'document-idle')),
    load_order  INTEGER NOT NULL DEFAULT 100,        -- lower runs first
    enabled     INTEGER NOT NULL DEFAULT 1,
    code        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

-- Key/value runtime settings editable in the admin panel ----------------------
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Proxy browsing sessions (one row per Rammerhead session) --------------------
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,                -- Rammerhead session id (32 chars)
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pool_id         INTEGER,
    proxy_id        INTEGER,                         -- sticky upstream proxy (NULL = direct)
    start_url       TEXT,
    client_ip       TEXT,
    user_agent      TEXT,
    requests        INTEGER NOT NULL DEFAULT 0,
    bytes           INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    end_requested   INTEGER NOT NULL DEFAULT 0,      -- set by portal, executed by proxy process
    ended_at        INTEGER,
    end_reason      TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_active ON sessions(ended_at);
CREATE INDEX idx_sessions_proxy ON sessions(proxy_id);

-- Daily usage counters (bandwidth / requests) per user ------------------------
CREATE TABLE usage_daily (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,                       -- YYYY-MM-DD (UTC)
    requests    INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- Audit / event log ------------------------------------------------------------
CREATE TABLE events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    type        TEXT NOT NULL,                       -- login, login_failed, session_start, blocked_domain, ...
    detail      TEXT,
    ip          TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_user ON events(user_id);

-- One-time tickets (portal -> proxy hand-off), stored to prevent replay -------
CREATE TABLE used_tickets (
    nonce       TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
);
