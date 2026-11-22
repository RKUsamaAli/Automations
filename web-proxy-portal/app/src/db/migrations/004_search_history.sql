-- Words each user searched for (Browse page and the top bar on proxied pages).
-- Shown as "Recent searches" under the search box; one row per distinct query
-- per user (searching again moves it to the top). Users can clear their list.
CREATE TABLE search_history (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query       TEXT NOT NULL,
    query_key   TEXT NOT NULL,                   -- lower-cased, for de-duplication
    searched_at INTEGER NOT NULL,                -- UTC ms of the latest search
    count       INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT,
    UNIQUE (user_id, query_key)
);
CREATE INDEX idx_search_history_user ON search_history(user_id, searched_at DESC);
