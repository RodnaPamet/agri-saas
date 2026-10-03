-- P1.9 — PlatformAuditLog: an append-only hash chain keyed by SCOPE.
--
-- Generalised from `OrgAuditLog` (20260xxxxx) and `AuditLog`: same canonical
-- payload, same SHA-256-over-previousHash chain, same advisory-lock ordering.
-- The chain KEY is what differs — `AuditLog` chains per tenant, `OrgAuditLog`
-- per organization, and a platform action belongs to neither.
--
-- ── why per-scope chains ──
--
-- The append takes `pg_advisory_xact_lock` on the chain key, so a single
-- platform-wide chain would serialise every platform write against every
-- other. Scope is also the unit a reader verifies: "is the key-rotation
-- history intact" should not require replaying feature-flag edits.
--
-- ── no FK on actorUserId, unlike OrgAuditLog ──
--
-- These surfaces authenticate with `X-Platform-Admin-Key`. That is a
-- credential, not a person, so there is usually no user to point at. An FK
-- would have forced a fictitious user or a relation that never resolves.

-- ─── 1) Enum ────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlatformAuditAction') THEN
        CREATE TYPE "PlatformAuditAction" AS ENUM (
            'FEATURE_FLAG_UPSERTED',
            'FEATURE_FLAG_COHORT_ADDED',
            'FEATURE_FLAG_COHORT_REMOVED',
            'KEY_ROTATION_SWEEP_RUN',
            'KEY_ROTATION_DEK_REWRAPPED',
            'KEY_ROTATION_V2_REPAIRED'
        );
    END IF;
END
$$;

-- ─── 2) Table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PlatformAuditLog" (
    "id"           TEXT NOT NULL,
    "scope"        TEXT NOT NULL,
    "actorType"    TEXT NOT NULL DEFAULT 'PLATFORM_ADMIN',
    "actorUserId"  TEXT,
    "action"       "PlatformAuditAction" NOT NULL,
    "detailsJson"  JSONB,
    "requestId"    TEXT,
    "occurredAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryHash"    TEXT NOT NULL,
    "previousHash" TEXT,
    "version"      INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PlatformAuditLog_scope_occurredAt_idx"
    ON "PlatformAuditLog" ("scope", "occurredAt");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_scope_action_idx"
    ON "PlatformAuditLog" ("scope", "action");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_scope_entryHash_idx"
    ON "PlatformAuditLog" ("scope", "entryHash");

-- ─── 3) Immutability, at the database ───────────────────────────────
--
-- Mirrors `audit_log_immutable_guard` (20260324010000). An audit chain whose
-- rows can be UPDATEd is not a chain: rewriting one entry and recomputing the
-- hashes after it would leave a structurally valid history that never
-- happened. The trigger is what makes the chain's tamper-evidence mean
-- anything, because the application could otherwise be persuaded to do exactly
-- that.
--
-- TRUNCATE is DDL and bypasses row-level triggers. Intentional, matching
-- AuditLog: tests need a reset path, and production controls it by role.
CREATE OR REPLACE FUNCTION platform_audit_log_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'IMMUTABLE_PLATFORM_AUDIT_LOG: % operations on "PlatformAuditLog" are forbidden. '
        'Entries are append-only and cannot be modified or removed.',
        TG_OP
    USING ERRCODE = 'restrict_violation';
    RETURN NULL; -- never reached
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_audit_log_immutable ON "PlatformAuditLog";

CREATE TRIGGER platform_audit_log_immutable
    BEFORE UPDATE OR DELETE ON "PlatformAuditLog"
    FOR EACH ROW
    EXECUTE FUNCTION platform_audit_log_immutable_guard();

-- ─── 4) Privilege hardening ─────────────────────────────────────────
-- Defence in depth on top of the trigger, as for AuditLog. `app_user` never
-- writes here in practice — the platform surfaces run on the privileged role —
-- but a grant it does not need is a grant worth not having.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        REVOKE UPDATE, DELETE ON "PlatformAuditLog" FROM app_user;
        GRANT SELECT, INSERT ON "PlatformAuditLog" TO app_user;
    END IF;
END
$$;
