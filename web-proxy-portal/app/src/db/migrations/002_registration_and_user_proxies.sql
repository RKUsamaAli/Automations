-- =============================================================================
-- 002 - self registration + user-owned proxies + pool sharing
-- Additive only (new columns with defaults, new table) so release 001 still
-- runs against this schema after a rollback.
-- =============================================================================

-- Users: optional e-mail, and "pending" while waiting for admin approval
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

-- Pools: owner_user_id NULL = admin pool, otherwise the user's private pool.
-- visibility (admin pools): 'all' = every user may pick it, 'assigned' = only users in pool_access.
ALTER TABLE proxy_pools ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE proxy_pools ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all';

CREATE TABLE pool_access (
    pool_id     INTEGER NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (pool_id, user_id)
);
CREATE INDEX idx_pool_access_user ON pool_access(user_id);
CREATE INDEX idx_pools_owner ON proxy_pools(owner_user_id);
