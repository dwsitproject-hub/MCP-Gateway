-- =====================================================================
-- 002 — Downstream Hub OIDC authentication (review H2)
--
-- The Hub becomes how a human proves WHO THEY ARE. It does not become the
-- authorization decision: the `users` table remains the pilot ALLOWLIST.
--
-- That split matters. Phase 1 uses one shared KLIP service account, so every
-- authenticated gateway user can read everything MCP_READONLY can read (review
-- H8). Pilot membership therefore *is* the access control, and JIT-provisioning
-- anyone the Hub authenticates would silently widen data access to the whole
-- organisation and blow through the "<= 15 pilot users" cap in PRD Section 16.
--
-- Idempotent, per PM-tool convention.
-- =====================================================================

-- Hub-authenticated accounts hold no password at all.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT NOT NULL DEFAULT 'hub'
  CHECK (auth_source IN ('hub', 'local'));

-- The Hub's `sub` claim. Pinned on first successful login so a later change of
-- email address cannot silently attach one person's access to another's account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hub_subject TEXT;

-- Exactly one break-glass account is expected: the local password path used only
-- when the Hub is unavailable or misconfigured.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_break_glass BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS users_hub_subject_idx ON users (hub_subject)
  WHERE hub_subject IS NOT NULL;

-- A local account must have a password; a Hub account must not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_auth_source_password') THEN
    ALTER TABLE users ADD CONSTRAINT users_auth_source_password CHECK (
      (auth_source = 'local' AND password_hash IS NOT NULL) OR
      (auth_source = 'hub'   AND password_hash IS NULL)
    );
  END IF;
END $$;

-- Any account created before this migration was a local password account.
UPDATE users SET auth_source = 'local', is_break_glass = TRUE
 WHERE password_hash IS NOT NULL AND auth_source = 'hub';

-- Short-lived state for an in-flight Hub round trip. A table rather than a cookie
-- because the PKCE verifier and the nonce must never leave the server, and the row
-- gives single-use semantics that a signed cookie cannot.
CREATE TABLE IF NOT EXISTS hub_auth_state (
  state          TEXT PRIMARY KEY,        -- SHA-256 hash of the value sent to the Hub
  pending_token  TEXT NOT NULL,           -- our signed pending-authorization JWT
  code_verifier  TEXT NOT NULL,           -- PKCE verifier for the GATEWAY -> HUB leg
  nonce          TEXT NOT NULL,           -- replay guard for the Hub's ID token
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS hub_auth_state_expiry_idx ON hub_auth_state (expires_at);

INSERT INTO schema_migrations (version) VALUES ('002_hub_oidc')
  ON CONFLICT (version) DO NOTHING;
