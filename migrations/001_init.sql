-- =====================================================================
-- MCP Gateway Phase 1 - initial schema (TSD Section 9.1)
-- Idempotent (PM-tool convention): safe to re-run at every boot.
--
-- Review fixes applied:
--   H9.1  audit_events is RANGE-partitioned by month from day one. The append-only
--         trigger blocks UPDATE/DELETE, so retention can only work by dropping a
--         partition - DROP TABLE does not fire row triggers. A non-partitioned
--         table would have made the documented 12-month retention impossible.
--   H9.3  client_ip is stored, so the real caller is recorded rather than the
--         nginx loopback address.
-- =====================================================================

-- ---------------------------------------------------------------------
-- OAuth 2.1 provider state
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                TEXT PRIMARY KEY,
  client_secret_hash       TEXT,                       -- SHA-256; NULL for public clients
  client_secret_expires_at TIMESTAMPTZ,
  client_name              TEXT NOT NULL,
  redirect_uris            TEXT[] NOT NULL,
  grant_types              TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token'],
  response_types           TEXT[] NOT NULL DEFAULT ARRAY['code'],
  scope                    TEXT NOT NULL DEFAULT 'klip:read',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at              TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  must_change_pw BOOLEAN NOT NULL DEFAULT TRUE,
  disabled_at    TIMESTAMPTZ,
  failed_logins  INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- Authorization codes: 60 s TTL, single use, bound to client + redirect_uri +
-- PKCE challenge + user + RFC 8707 resource.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code           TEXT PRIMARY KEY,          -- SHA-256 hash of the issued code
  client_id      TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_codes_expiry_idx ON oauth_codes (expires_at);

-- Refresh tokens: opaque, stored SHA-256 hashed, rotated on every use.
-- Reuse of a consumed token revokes the whole family.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  family_id    UUID NOT NULL,
  client_id    TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope        TEXT NOT NULL,
  resource     TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx   ON oauth_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_live_idx   ON oauth_tokens (expires_at) WHERE revoked_at IS NULL;

-- Access-token denylist. Access tokens are stateless RS256 JWTs, so revocation
-- (kill switch S8, user disable) needs an explicit denylist checked on verify.
CREATE TABLE IF NOT EXISTS revoked_access_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT
);

CREATE INDEX IF NOT EXISTS revoked_access_tokens_expiry_idx ON revoked_access_tokens (expires_at);

-- A global cutoff is the cheapest correct kill switch: any access token issued
-- at or before this instant is invalid, without enumerating jtis.
CREATE TABLE IF NOT EXISTS auth_revocation_epoch (
  id         BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  not_before TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason     TEXT
);

INSERT INTO auth_revocation_epoch (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- Audit store - append only, monthly partitions
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id              BIGSERIAL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id      UUID NOT NULL,
  user_id         TEXT NOT NULL,
  client_ip       TEXT,
  oauth_client_id TEXT,
  event           TEXT NOT NULL CHECK (event IN
                    ('tool_request','tool_outcome','auth_login','auth_fail',
                     'token_issued','token_revoked','guard_block','admin_action')),
  tool            TEXT,
  params          JSONB,
  klip_calls      JSONB,
  row_count       INT,
  latency_ms      INT,
  outcome         TEXT,
  detail          JSONB,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS audit_events_ts_idx        ON audit_events (ts);
CREATE INDEX IF NOT EXISTS audit_events_user_ts_idx   ON audit_events (user_id, ts);
CREATE INDEX IF NOT EXISTS audit_events_request_idx   ON audit_events (request_id);
CREATE INDEX IF NOT EXISTS audit_events_event_ts_idx  ON audit_events (event, ts);

-- Create partitions for the surrounding months. ensure_audit_partitions() is called
-- at boot and can be scheduled monthly; retention is a DROP of the oldest partition.
CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead INT DEFAULT 2)
RETURNS void AS $$
DECLARE
  m      DATE := date_trunc('month', now())::date - INTERVAL '1 month';
  target DATE := date_trunc('month', now())::date + (months_ahead || ' months')::INTERVAL;
  name   TEXT;
BEGIN
  WHILE m <= target LOOP
    name := format('audit_events_%s', to_char(m, 'YYYYMM'));
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = name) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
        name, m, (m + INTERVAL '1 month')::date);
    END IF;
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
END $$ LANGUAGE plpgsql;

SELECT ensure_audit_partitions(2);

-- Default partition catches any row outside the created range so an insert can
-- never fail for want of a partition (audit writes must not be droppable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'audit_events_default') THEN
    EXECUTE 'CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT';
  END IF;
END $$;

-- Append-only enforcement (pattern proven in Inventory-Item's audit.audit_events).
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON audit_events;
CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ---------------------------------------------------------------------
-- Schema version marker
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_init')
  ON CONFLICT (version) DO NOTHING;
