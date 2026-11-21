-- ============================================================================
--  0001_identity.sql — identity, access, scope and audit foundation
--
--  Design rules encoded here:
--    * Three account classes only (USER, STAFF, ROOT) enforced by CHECK.
--    * STAFF/ROOT rows must have a staff_profile; USER must not. Enforced by FK
--      direction from staff_profiles, which only references STAFF/ROOT rows.
--    * ROOT cannot be deleted (trigger), cannot be demoted (trigger).
--    * Permissions are stored as exact numeric, mirroring the kernel's
--      arbitrary-precision mask. No bit(64) truncation, no float.
--    * Every mutation on identity/access tables is captured by an append-only
--      audit trail written from the application, plus an immutability trigger.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid() fallback, digest()
CREATE EXTENSION IF NOT EXISTS "citext";        -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enumerated domains. Postgres ENUM is avoided deliberately: adding a value to
-- a widely used enum requires a rewrite lock, while a CHECK on text is an
-- online-validatable constraint. Domains keep single-source-of-truth semantics.
-- ---------------------------------------------------------------------------

CREATE DOMAIN account_type AS text
  CONSTRAINT account_type_allowed CHECK (VALUE IN ('USER', 'STAFF', 'ROOT'));

CREATE DOMAIN account_state AS text
  CONSTRAINT account_state_allowed CHECK (
    VALUE IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DEACTIVATED', 'SOFT_DELETED')
  );

CREATE DOMAIN scope_level AS text
  CONSTRAINT scope_level_allowed CHECK (VALUE IN ('COMPANY', 'REGION', 'BRANCH', 'DEPARTMENT', 'POSITION'));

-- ---------------------------------------------------------------------------
-- accounts: the single identity row for every human (or system principal).
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id                uuid PRIMARY KEY,
  account_type      account_type  NOT NULL,
  state             account_state NOT NULL DEFAULT 'PENDING_VERIFICATION',
  email             citext        NOT NULL,
  email_verified_at timestamptz,
  phone             text,
  phone_verified_at timestamptz,
  -- Argon2id encoded hash only; never a password, never reversible.
  password_hash     text,
  -- TOTP secret is encrypted at rest by the application (envelope, KMS-held DEK).
  mfa_secret_cipher text,
  mfa_enabled_at    timestamptz,
  -- Bumped on every credential change to invalidate outstanding refresh tokens
  -- without touching the token table.
  session_epoch     integer       NOT NULL DEFAULT 0,
  failed_login_count smallint     NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT accounts_email_is_normalised CHECK (email = lower(email::text)),
  CONSTRAINT accounts_phone_shape CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT accounts_session_epoch_non_negative CHECK (session_epoch >= 0),
  CONSTRAINT accounts_failed_login_non_negative CHECK (failed_login_count >= 0)
);

-- Unique among live identities only: a soft-deleted account releases its email
-- so the same person can register again without support intervention.
CREATE UNIQUE INDEX accounts_email_live_key ON accounts (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX accounts_phone_live_key ON accounts (phone) WHERE deleted_at IS NULL AND phone IS NOT NULL;
CREATE INDEX accounts_type_state_idx ON accounts (account_type, state);
CREATE INDEX accounts_created_at_idx ON accounts (created_at DESC);

-- At most two ROOT accounts, enforced by the database, not by application code
-- (see the accounts_enforce_root_cap trigger below).

COMMENT ON TABLE accounts IS 'One row per human identity. Soft delete only; hard deletes are forbidden by policy.';
COMMENT ON COLUMN accounts.session_epoch IS 'Incremented on password/MFA change; refresh tokens carry the epoch they were minted under.';

-- ---------------------------------------------------------------------------
-- profiles: external (USER) and internal (STAFF/ROOT) are separate relations
-- on purpose. HR data must never be reachable from an external query path.
-- ---------------------------------------------------------------------------
CREATE TABLE user_profiles (
  account_id  uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  username    citext NOT NULL,
  display_name text NOT NULL,
  bio         text,
  avatar_key  text,
  banner_key  text,
  country_code char(2),
  language    text NOT NULL DEFAULT 'en',
  timezone    text NOT NULL DEFAULT 'UTC',
  birth_date  date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_profiles_username_shape CHECK (username ~ '^[a-z0-9_]{3,30}$'),
  CONSTRAINT user_profiles_display_name_len CHECK (char_length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT user_profiles_bio_len CHECK (bio IS NULL OR char_length(bio) <= 500)
);

CREATE UNIQUE INDEX user_profiles_username_key ON user_profiles (username);

CREATE TABLE staff_profiles (
  account_id   uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE RESTRICT,
  employee_no  text NOT NULL,
  job_title    text NOT NULL,
  primary_scope_id uuid,
  manager_id   uuid REFERENCES accounts (id) ON DELETE SET NULL,
  hired_on     date NOT NULL,
  terminated_on date,
  employment_status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT staff_employment_status_allowed CHECK (employment_status IN ('ACTIVE', 'ON_LEAVE', 'TERMINATED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staff_profiles_dates_order CHECK (terminated_on IS NULL OR terminated_on >= hired_on)
);

CREATE UNIQUE INDEX staff_profiles_employee_no_key ON staff_profiles (employee_no);

-- ---------------------------------------------------------------------------
-- Scope graph: COMPANY > REGION > BRANCH > DEPARTMENT > POSITION
-- Materialised path keeps ancestry checks O(1) and cache-friendly.
-- ---------------------------------------------------------------------------
CREATE TABLE scopes (
  id         uuid PRIMARY KEY,
  level      scope_level NOT NULL,
  path       text NOT NULL,
  name       text NOT NULL,
  parent_id  uuid REFERENCES scopes (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scopes_path_shape CHECK (path ~ '^/[a-z0-9-]+/([a-z0-9-]+/)*$'),
  CONSTRAINT scopes_path_unique UNIQUE (path)
);

CREATE INDEX scopes_path_prefix_idx ON scopes (path text_pattern_ops);
CREATE INDEX scopes_level_idx ON scopes (level);

ALTER TABLE staff_profiles
  ADD CONSTRAINT staff_profiles_primary_scope_fk
  FOREIGN KEY (primary_scope_id) REFERENCES scopes (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- RBAC tables.
-- ---------------------------------------------------------------------------
CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_key_shape CHECK (key ~ '^[a-z_]+:[a-z_]+$')
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY,
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  -- ROOT-only roles are not assignable to STAFF or USER. This is the one place
  -- the privilege ceiling is expressed declaratively.
  min_account_type account_type NOT NULL DEFAULT 'USER',
  is_system   boolean NOT NULL DEFAULT false,
  -- Permission mask, exact arbitrary precision (matches PermissionMask#toString).
  permission_mask numeric(39, 0) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT roles_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  CONSTRAINT roles_mask_non_negative CHECK (permission_mask >= 0)
);

CREATE UNIQUE INDEX roles_code_key ON roles (code);

CREATE TABLE role_permissions (
  role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);

-- Grants are scoped: a role assignment is always "this role, on this node of the
-- scope tree". External USER roles live at the virtual ROOT scope of their own
-- account and therefore never appear here.
CREATE TABLE user_roles (
  id           uuid PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  scope_id     uuid REFERENCES scopes (id) ON DELETE CASCADE,
  granted_by   uuid REFERENCES accounts (id) ON DELETE SET NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,

  CONSTRAINT user_roles_expiry_future CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE UNIQUE INDEX user_roles_unique_grant ON user_roles
  (account_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX user_roles_account_idx ON user_roles (account_id);
CREATE INDEX user_roles_scope_idx ON user_roles (scope_id);

-- ---------------------------------------------------------------------------
-- Sessions and refresh tokens.
--
-- Refresh tokens are stored as SHA-256 digests, rotated on every use, and
-- organised into families. Reuse of a consumed token revokes the whole family —
-- that is the standard detection signal for a stolen token.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id             uuid PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_agent     text,
  ip_hash        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,

  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX sessions_account_live_idx ON sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_digest  bytea NOT NULL,
  family_id     uuid NOT NULL,
  parent_id     uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  session_epoch integer NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  revoked_at    timestamptz,

  CONSTRAINT refresh_tokens_digest_len CHECK (octet_length(token_digest) = 32)
);

CREATE UNIQUE INDEX refresh_tokens_digest_key ON refresh_tokens (token_digest);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

-- ---------------------------------------------------------------------------
-- One-time codes: email verification, password reset, login OTP, invitations.
-- Only the digest is stored, so a database leak cannot be replayed.
-- ---------------------------------------------------------------------------
CREATE TABLE verification_codes (
  id          uuid PRIMARY KEY,
  account_id  uuid REFERENCES accounts (id) ON DELETE CASCADE,
  purpose     text NOT NULL
    CONSTRAINT verification_purpose_allowed CHECK (purpose IN (
      'EMAIL_VERIFY', 'PHONE_VERIFY', 'PASSWORD_RESET', 'LOGIN_OTP', 'MFA_ENROLL', 'EMAIL_CHANGE'
    )),
  channel     text NOT NULL
    CONSTRAINT verification_channel_allowed CHECK (channel IN ('EMAIL', 'SMS')),
  destination_hash bytea NOT NULL,
  code_digest bytea NOT NULL,
  attempts    smallint NOT NULL DEFAULT 0,
  max_attempts smallint NOT NULL DEFAULT 5,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,

  CONSTRAINT verification_codes_digest_len CHECK (octet_length(code_digest) = 32),
  CONSTRAINT verification_codes_attempts_bounded CHECK (attempts BETWEEN 0 AND max_attempts)
);

CREATE INDEX verification_codes_lookup_idx ON verification_codes (account_id, purpose, created_at DESC);
CREATE INDEX verification_codes_expiry_idx ON verification_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Audit trail: append-only, hash-chained per day.
--
-- `entry_hash` = SHA-256(previous_hash || canonical payload). A deleted or
-- rewritten row therefore breaks the chain, which is what makes the trail
-- evidence rather than logs.
-- ---------------------------------------------------------------------------
-- No foreign keys on purpose: an audit row records what was true at the time and
-- must outlive the rows it references. A cascading FK would rewrite history
-- (ON DELETE SET NULL performs an UPDATE, which the immutability trigger rejects).
CREATE TABLE audit_events (
  id            uuid PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  actor_type    account_type,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  scope_id      uuid,
  outcome       text NOT NULL DEFAULT 'SUCCESS'
    CONSTRAINT audit_outcome_allowed CHECK (outcome IN ('SUCCESS', 'DENIED', 'ERROR')),
  ip_hash       text,
  user_agent    text,
  trace_id      text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash bytea,
  entry_hash    bytea NOT NULL,

  -- Multi-segment, dotted, lowercase: `auth.login.success`, `finance.payout.approved`.
  CONSTRAINT audit_events_action_shape CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT audit_events_hash_len CHECK (octet_length(entry_hash) = 32)
);

CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Triggers.
-- ---------------------------------------------------------------------------

-- updated_at maintenance, one function reused by every table that has the column.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_profiles_set_updated_at
  BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER staff_profiles_set_updated_at
  BEFORE UPDATE ON staff_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ROOT is permanent: it cannot be deleted, and its account_type cannot change.
CREATE OR REPLACE FUNCTION protect_root_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.account_type = 'ROOT' THEN
      RAISE EXCEPTION 'ROOT accounts cannot be deleted (account %)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.account_type = 'ROOT' AND NEW.account_type <> 'ROOT' THEN
    RAISE EXCEPTION 'ROOT accounts cannot be demoted (account %)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Credential changes rotate the session epoch, which invalidates every
  -- outstanding refresh token for the account.
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.mfa_enabled_at IS DISTINCT FROM OLD.mfa_enabled_at
     OR NEW.mfa_secret_cipher IS DISTINCT FROM OLD.mfa_secret_cipher THEN
    NEW.session_epoch := OLD.session_epoch + 1;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_protect_root
  BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION protect_root_account();

-- At most MAX_ROOT_ACCOUNTS (2) live ROOT accounts.
CREATE OR REPLACE FUNCTION enforce_root_account_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  live_roots integer;
BEGIN
  IF NEW.account_type <> 'ROOT' OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO live_roots
  FROM accounts
  WHERE account_type = 'ROOT' AND deleted_at IS NULL AND id <> NEW.id;

  IF live_roots >= 2 THEN
    RAISE EXCEPTION 'ROOT account cap (2) reached; refusing to add another ROOT'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_root_cap
  BEFORE INSERT OR UPDATE OF account_type ON accounts
  FOR EACH ROW EXECUTE FUNCTION enforce_root_account_cap();

-- STAFF and ROOT must never exist without an HR profile; USER must never have one.
CREATE OR REPLACE FUNCTION enforce_staff_profile_presence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offending uuid;
BEGIN
  SELECT id INTO offending
  FROM accounts a
  LEFT JOIN staff_profiles p ON p.account_id = a.id
  WHERE (a.account_type IN ('STAFF', 'ROOT') AND p.account_id IS NULL AND a.deleted_at IS NULL)
     OR (a.account_type = 'USER' AND p.account_id IS NOT NULL)
  LIMIT 1;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'account % violates the STAFF/ROOT <-> staff_profiles invariant', offending
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER accounts_staff_profile_invariant
  AFTER INSERT OR UPDATE OF account_type ON accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_staff_profile_presence();

-- Audit rows are immutable once written.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
