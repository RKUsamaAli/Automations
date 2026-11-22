-- Time zones ---------------------------------------------------------------
-- All timestamps stay UTC epoch milliseconds. Usage moves from per-UTC-day rows
-- to 15-minute UTC slots, so "today" and per-day totals can be cut at the
-- viewer's local midnight in ANY time zone (incl. +05:30 / +05:45 zones).

-- The user's browser time zone (last seen), e.g. 'Asia/Karachi'. Used for the
-- user's daily traffic limit and shown to admins. NULL = UTC.
ALTER TABLE users ADD COLUMN timezone TEXT;

CREATE TABLE usage_slots (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL,                    -- UTC epoch ms of the slot start (multiple of 900000)
    requests    INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, slot)
);
CREATE INDEX idx_usage_slots_slot ON usage_slots (slot);

-- Keep existing history: each old UTC day becomes one slot at 00:00 UTC.
INSERT INTO usage_slots (user_id, slot, requests, bytes)
SELECT user_id, CAST(strftime('%s', day) AS INTEGER) * 1000, requests, bytes FROM usage_daily;

DROP TABLE usage_daily;
