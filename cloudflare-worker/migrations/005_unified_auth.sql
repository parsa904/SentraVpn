-- ============================================================================
-- Migration 005: Unified Authentication (Username, Salted Password Hash & Optional Email)
-- Compatible with Cloudflare D1 (`wrangler d1 migrations apply sentra-db --remote`)
-- Note: `users.telegram_id` is already nullable in `schema.sql` so users can register
-- directly in the SentraVPN app and later link their Telegram account.
-- ============================================================================

-- 1. Ensure unified credential columns exist on `users`
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email TEXT;

-- 2. Case-insensitive unique index on username & optional email lookup index
DROP INDEX IF EXISTS idx_users_username;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));
