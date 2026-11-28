-- ============================================================================
-- Migration 007: Unified Sync Revisions (`account_rev` on `subscriptions`)
-- Enables O(1) weak ETag (`W/"<nodes_rev>-<account_rev>-<app_version>"`) and
-- instant HTTP 304 Not Modified responses across Telegram Mini App & Clients.
-- ============================================================================

ALTER TABLE subscriptions ADD COLUMN account_rev INTEGER NOT NULL DEFAULT 1;
