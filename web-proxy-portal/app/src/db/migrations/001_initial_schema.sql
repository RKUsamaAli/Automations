-- =============================================================================
-- Web Proxy Portal - initial schema (release 1)
--
-- Conventions for EVERY table:
--   id          TEXT PRIMARY KEY   GUID (UUID v7: random, but ordered by creation
--                                  time, so indexes stay compact and "newest first"
--                                  is simply ORDER BY id DESC)
--   created_at  INTEGER NOT NULL   UTC, epoch milliseconds
--   created_by  TEXT               users.id of who created the row, NULL = system
--   updated_at  INTEGER NOT NULL   UTC, epoch milliseconds (= created_at at first)
--   updated_by  TEXT               users.id of the last editor, NULL = system
--
-- All times are UTC. The browser sends its time zone (X-Timezone) and the
-- server converts only for display/grouping (see src/lib/timezone.js).
-- created_by / updated_by are filled automatically from the signed-in user of
-- the current request (src/lib/context.js).
-- =============================================================================

-- Users -----------------------------------------------------------------------
CREATE TABLE users (
    id                     TEXT PRIMARY KEY,
    username               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email                  TEXT,
    password_hash          TEXT,                     -- scrypt; NULL = access-code-only user
    access_token_hash      TEXT UNIQUE,              -- sha256 of the access code; NULL = none
    role                   TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    enabled                INTEGER NOT NULL DEFAULT 1,
    pending                INTEGER NOT NULL DEFAULT 0, -- signed up, waiting for admin approval
    pool_id                TEXT REFERENCES proxy_pools(id) ON DELETE SET NULL, -- pool override
    rate_limit_rpm         INTEGER,                  -- NULL = global default
    bandwidth_limit_mb_day INTEGER,                  -- NULL = global default, 0 = unlimited
    token_version          INTEGER NOT NULL DEFAULT 1, -- bump = sign out everywhere
    timezone               TEXT,                     -- browser zone last seen, e.g. Asia/Karachi
    note                   TEXT,
    last_login_at          INTEGER,
    created_at             INTEGER NOT NULL,
    created_by             TEXT,
    updated_at             INTEGER NOT NULL,
    updated_by             TEXT
);

-- Upstream proxy pools and proxies ---------------------------------------------
CREATE TABLE proxy_pools (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    country        TEXT,                             -- tag, e.g. US
    type           TEXT NOT NULL DEFAULT 'datacenter' CHECK (type IN ('residential', 'isp', 'datacenter', 'mobile', 'other')),
    is_default     INTEGER NOT NULL DEFAULT 0,       -- used when no site/user rule matches
    description    TEXT,
    owner_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE, -- set = a user's own "My proxies" pool
    visibility     TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'assigned')),
    created_at     INTEGER NOT NULL,
    created_by     TEXT,
    updated_at     INTEGER NOT NULL,
    updated_by     TEXT
);
CREATE INDEX idx_pools_owner ON proxy_pools(owner_user_id);

-- Which users may use an 'assigned' pool.
CREATE TABLE pool_access (
    id          TEXT PRIMARY KEY,
    pool_id     TEXT NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT,
    UNIQUE (pool_id, user_id)
);
CREATE INDEX idx_pool_access_user ON pool_access(user_id);

CREATE TABLE proxies (
    id              TEXT PRIMARY KEY,
    pool_id         TEXT NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
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
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT,
    UNIQUE (pool_id, protocol, host, port, username)
);
CREATE INDEX idx_proxies_pool ON proxies(pool_id, id);

-- Health-check history per proxy.
CREATE TABLE proxy_checks (
    id          TEXT PRIMARY KEY,
    proxy_id    TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    latency_ms  INTEGER,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);
CREATE INDEX idx_checks_proxy ON proxy_checks(proxy_id, created_at);
CREATE INDEX idx_checks_created ON proxy_checks(created_at);

-- Site tiles and injected scripts -------------------------------------------------
CREATE TABLE sites (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    start_url       TEXT NOT NULL,
    domains         TEXT NOT NULL,                   -- comma separated patterns, e.g. "*.example.com"
    pool_id         TEXT REFERENCES proxy_pools(id) ON DELETE SET NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    show_on_landing INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT
);

CREATE TABLE scripts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    domains     TEXT NOT NULL DEFAULT '*',           -- patterns this script runs on
    run_at      TEXT NOT NULL DEFAULT 'document-end' CHECK (run_at IN ('document-start', 'document-end', 'document-idle')),
    load_order  INTEGER NOT NULL DEFAULT 100,        -- lower runs first
    enabled     INTEGER NOT NULL DEFAULT 1,
    code        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

-- Key/value settings edited in Admin -> Settings.
CREATE TABLE settings (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    value       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);

-- Browsing sessions ------------------------------------------------------------
-- id = the Rammerhead session id: 32 random hex characters (a 128-bit GUID
-- without dashes, the format the proxy engine requires in its URLs).
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pool_id         TEXT,
    proxy_id        TEXT,                            -- sticky upstream proxy (NULL = direct)
    start_url       TEXT,
    client_ip       TEXT,
    user_agent      TEXT,
    client_id       TEXT,                            -- client_devices.id of the browser that started it
    requests        INTEGER NOT NULL DEFAULT 0,
    bytes           INTEGER NOT NULL DEFAULT 0,
    last_seen_at    INTEGER NOT NULL,
    end_requested   INTEGER NOT NULL DEFAULT 0,      -- set by the portal, executed by the proxy process
    ended_at        INTEGER,
    end_reason      TEXT,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_active ON sessions(ended_at, last_seen_at);
CREATE INDEX idx_sessions_proxy ON sessions(proxy_id);

-- One-time hand-off tickets already used (replay protection).
CREATE TABLE used_tickets (
    id          TEXT PRIMARY KEY,
    nonce       TEXT NOT NULL UNIQUE,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);
CREATE INDEX idx_tickets_expires ON used_tickets(expires_at);

-- Usage per user in 15-minute UTC slots (regrouped into any time zone's days).
CREATE TABLE usage_slots (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL,                    -- UTC epoch ms of the slot start (multiple of 900000)
    requests    INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT,
    UNIQUE (user_id, slot)
);
CREATE INDEX idx_usage_slot ON usage_slots(slot);

-- Logs ------------------------------------------------------------------------------
-- Browsers/devices seen, stored ONCE per distinct device and referenced by
-- log rows (client_id), so every log line knows the real browser, OS, device,
-- screen, language and zone without repeating it. Filled from the User-Agent,
-- Client Hints and the X-Client header the portal pages send.
CREATE TABLE client_devices (
    id              TEXT PRIMARY KEY,
    fingerprint     TEXT NOT NULL UNIQUE,            -- sha1 of the stable fields below
    user_agent      TEXT,
    browser         TEXT,                            -- Chrome, Safari, Firefox, Edge, Samsung Internet ...
    browser_version TEXT,
    engine          TEXT,                            -- Blink, WebKit, Gecko
    os              TEXT,                            -- iOS, Android, Windows, macOS, Linux ...
    os_version      TEXT,
    device_type     TEXT,                            -- desktop | mobile | tablet | bot
    device_model    TEXT,                            -- iPhone, iPad, SM-S918B ... (when known)
    screen          TEXT,                            -- 390x844
    pixel_ratio     REAL,
    language        TEXT,                            -- en-US
    languages       TEXT,                            -- en-US,en
    timezone        TEXT,                            -- Asia/Karachi
    touch           INTEGER,                         -- 1 = touch screen
    memory_gb       REAL,                            -- navigator.deviceMemory (Chrome only)
    cpu_cores       INTEGER,                         -- navigator.hardwareConcurrency
    last_seen_at    INTEGER NOT NULL,
    last_viewport   TEXT,                            -- 390x664 (window size at last sight)
    last_network    TEXT,                            -- 4g, wifi ... (Network Information API)
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT
);

-- Activity log: every action (sign-in, user created, pool edited, deploy ...) and
-- every warning/error the app logs. created_by = who did it.
CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,                       -- login, admin_user_created, deploy_succeeded ...
    level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
    source      TEXT NOT NULL DEFAULT 'system',      -- web | proxy | cli | job | deploy | system
    detail      TEXT,                                -- short human text
    target      TEXT,                                -- what it was done to: 'user:<id>', 'pool:<id>' ...
    changes     TEXT,                                -- JSON {"field": [old, new]} (secrets masked)
    ip          TEXT,
    request_id  TEXT,                                -- matches request_log / error_reports / nginx
    client_id   TEXT,                                -- client_devices.id (browser / OS / device)
    server      TEXT,                                -- hostname of the server that handled it
    process     TEXT,                                -- web:0 | proxy:2 | cli | deploy ...
    release     TEXT,                                -- app release running at the time
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_by ON events(created_by, id);
CREATE INDEX idx_events_type ON events(type, id);
CREATE INDEX idx_events_target ON events(target);

-- What users did (pages, portal actions, failures). created_by = the user.
CREATE TABLE request_log (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,                       -- proxy | web
    kind        TEXT NOT NULL,                       -- page | resource | api | view
    session_id  TEXT,                                -- browsing session (proxy)
    method      TEXT,
    url         TEXT,                                -- redacted
    host        TEXT,
    status      INTEGER,                             -- 0 = connection failed / aborted
    ms          INTEGER,
    bytes       INTEGER,
    proxy_id    TEXT,
    request_id  TEXT,
    error       TEXT,
    ip          TEXT,
    client_id   TEXT,                                -- client_devices.id
    server      TEXT,                                -- hostname
    process     TEXT,                                -- web:0 | proxy:2 ...
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT
);
CREATE INDEX idx_reqlog_created ON request_log(created_at);
CREATE INDEX idx_reqlog_session ON request_log(session_id, id);
CREATE INDEX idx_reqlog_by ON request_log(created_by, id);
CREATE INDEX idx_reqlog_status ON request_log(status, created_at);

-- Error reports with the steps before the failure. created_by = affected user;
-- updated_by = admin who resolved/reopened it.
CREATE TABLE error_reports (
    id            TEXT PRIMARY KEY,
    ref           TEXT NOT NULL UNIQUE,              -- shown to the user, e.g. E-7K2P9Q
    last_seen_at  INTEGER NOT NULL,
    occurrences   INTEGER NOT NULL DEFAULT 1,
    source        TEXT NOT NULL,                     -- web | proxy | client
    kind          TEXT NOT NULL,                     -- page_load_failed, server_exception, client_js ...
    severity      TEXT NOT NULL DEFAULT 'error',     -- error | warning
    fingerprint   TEXT NOT NULL,                     -- groups identical errors
    message       TEXT NOT NULL,
    stack         TEXT,
    session_id    TEXT,
    request_id    TEXT,
    release       TEXT,
    url           TEXT,                              -- redacted
    dest_host     TEXT,
    proxy_id      TEXT,
    pool_id       TEXT,
    client_ip     TEXT,
    user_agent    TEXT,
    client_id     TEXT,                              -- client_devices.id (browser / OS / device / screen)
    server        TEXT,                              -- hostname
    process       TEXT,                              -- web:0 | proxy:2 ...
    system        TEXT,                              -- JSON: node version, memory, load, uptime at the time
    context       TEXT,                              -- JSON
    breadcrumbs   TEXT,                              -- JSON: the steps before the error
    resolved      INTEGER NOT NULL DEFAULT 0,
    resolved_at   INTEGER,
    note          TEXT,
    created_at    INTEGER NOT NULL,
    created_by    TEXT,
    updated_at    INTEGER NOT NULL,
    updated_by    TEXT
);
CREATE INDEX idx_errors_created ON error_reports(created_at);
CREATE INDEX idx_errors_fingerprint ON error_reports(fingerprint);
CREATE INDEX idx_errors_by ON error_reports(created_by);
CREATE INDEX idx_errors_open ON error_reports(resolved, last_seen_at);

-- Per-process health samples, one per minute.
CREATE TABLE server_metrics (
    id              TEXT PRIMARY KEY,
    process         TEXT NOT NULL,                   -- web:0 | proxy | proxy:2 ...
    pid             INTEGER NOT NULL,
    release         TEXT,
    uptime_s        INTEGER,
    rss_mb          REAL,
    heap_mb         REAL,
    cpu_pct         REAL,                            -- of one core, over the interval
    load1           REAL,
    free_mem_mb     REAL,
    loop_lag_ms     REAL,                            -- event-loop delay p99
    requests        INTEGER,
    errors          INTEGER,
    p95_ms          INTEGER,
    active_sessions INTEGER,
    created_at      INTEGER NOT NULL,
    created_by      TEXT,
    updated_at      INTEGER NOT NULL,
    updated_by      TEXT
);
CREATE INDEX idx_metrics_created ON server_metrics(created_at);
