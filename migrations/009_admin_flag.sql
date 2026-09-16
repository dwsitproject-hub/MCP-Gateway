-- 009_admin_flag.sql
--
-- Who may administer the pilot list from the web UI.
--
-- The UI lives on the PUBLIC host, alongside a page that grants access to production
-- commercial data, so the flag is deliberately separate from everything else:
--
--   Hub authentication  proves who you are
--   pilot list          proves you may use the connector
--   is_admin            proves you may change who else may use it
--
-- Three decisions, three checks. A pilot user is NOT an administrator by being on the
-- list, because the list is the data-access control and anyone who can edit it can
-- grant themselves nothing new but can grant it to anybody.
--
-- NOBODY IS AN ADMIN BY DEFAULT, including the person who deploys this. The first
-- admin is granted from the CLI (`user:grant-admin`), which needs shell access to the
-- host. That is the point: a web UI that can mint its own first administrator is a
-- self-service door, and this host takes automated /admin and formLogin probes all day.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Finding the admins is a per-request question on every admin page load, and the set
-- is tiny, so a partial index keeps it off a sequential scan of the pilot table.
CREATE INDEX IF NOT EXISTS users_is_admin_idx ON users (is_admin) WHERE is_admin = TRUE;

COMMIT;
