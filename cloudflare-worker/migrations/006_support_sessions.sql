-- ============================================================================
-- Migration 006: Support Sessions (Auto-Escalated Dedicated Forum Topics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS support_sessions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                 INTEGER NOT NULL,
    topic_thread_id         INTEGER,
    message_count           INTEGER NOT NULL DEFAULT 0,
    last_user_message_id    INTEGER,
    status                  TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_user_status
    ON support_sessions(user_id, status);

CREATE INDEX IF NOT EXISTS idx_support_sessions_topic_status
    ON support_sessions(topic_thread_id, status);
