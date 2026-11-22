-- =============================================================================
-- 004 - operational logs for normal activity, not only failures
--
--   request_log   what users did: proxied page views, portal actions, failures
--   server_metrics one row per process per minute: memory, CPU, event-loop lag,
--                  traffic, errors, latency -> explains server problems
--   proxy_checks  history of every upstream proxy health check
--
-- Written in batches every few seconds; pruned by the maintenance job.
-- Additive only.
-- =============================================================================
CREATE TABLE request_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    source      TEXT NOT NULL,               -- proxy | web
    kind        TEXT NOT NULL,               -- page | resource | api | view
    user_id     INTEGER,
    session_id  TEXT,                        -- browsing session (proxy)
    method      TEXT,
    url         TEXT,                        -- redacted
    host        TEXT,                        -- destination site (proxy) or portal
    status      INTEGER,                     -- 0 = connection failed / aborted
    ms          INTEGER,
    bytes       INTEGER,
    proxy_id    INTEGER,
    request_id  TEXT,
    error       TEXT
);
CREATE INDEX idx_reqlog_ts ON request_log(ts);
CREATE INDEX idx_reqlog_session ON request_log(session_id, ts);
CREATE INDEX idx_reqlog_user ON request_log(user_id, ts);
CREATE INDEX idx_reqlog_status ON request_log(status, ts);

CREATE TABLE server_metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    process       TEXT NOT NULL,             -- web | proxy | proxy:2 (cluster worker) ...
    pid           INTEGER NOT NULL,
    release       TEXT,
    uptime_s      INTEGER,
    rss_mb        REAL,
    heap_mb       REAL,
    cpu_pct       REAL,                      -- of one core, over the interval
    load1         REAL,                      -- machine load average
    free_mem_mb   REAL,                      -- machine free memory
    loop_lag_ms   REAL,                      -- event-loop delay p99 (responsiveness)
    requests      INTEGER,                   -- in the interval
    errors        INTEGER,                   -- 5xx / failed in the interval
    p95_ms        INTEGER,                   -- response time
    active_sessions INTEGER
);
CREATE INDEX idx_metrics_ts ON server_metrics(ts);

CREATE TABLE proxy_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    proxy_id    INTEGER NOT NULL,
    ok          INTEGER NOT NULL,
    latency_ms  INTEGER,
    error       TEXT
);
CREATE INDEX idx_checks_proxy ON proxy_checks(proxy_id, ts);
CREATE INDEX idx_checks_ts ON proxy_checks(ts);
