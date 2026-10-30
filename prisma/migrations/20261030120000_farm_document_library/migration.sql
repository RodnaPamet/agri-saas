-- «Документи» — a farm's document library, tables only (#2495).
--
-- Schema ahead of the code that writes it, which is P5's own rule: tables ship
-- one release before the routes, so nothing lands half-wired. No route, UI or
-- flag comes with this migration. Purely additive: two new tables, three new
-- enums, no existing column changed and nothing dropped.
--
-- Decisions this encodes, each ruled on rather than defaulted (#2495):
--
--   · MECHANISATOR gets no access, so there is nothing here for that persona
--     and `isOperatorAllowedPath` is untouched. A document library will hold
--     lease contracts, and `ParcelLease.lessorName` is encrypted precisely
--     because it names a third party.
--   · Expiry and manual deletion BOTH leave a tombstone — the row survives
--     with `purgedAt`, the bytes do not. An absence and a deletion must not
--     look alike.
--   · The per-tenant byte ceiling is an env var, not a column and not
--     `PLAN_LIMITS`: `STRIPE_SECRET_KEY` is absent on the VM, so every tenant
--     resolves to ENTERPRISE and every ENTERPRISE limit is null — a
--     plan-based cap would have enforced nothing.

-- ── Enums ────────────────────────────────────────────────────────────
--
-- `DocumentRetention`'s values ARE the wire values, so there is no mapping
-- layer to disagree with itself. ISO-8601 duration codes rather than a day
-- count, because months and years in days reintroduces the leap-year question
-- at every read.
CREATE TYPE "DocumentRetention" AS ENUM ('P3M', 'P6M', 'P1Y', 'P2Y', 'P5Y', 'NONE');

-- `OFF` is "sync was not on when this was uploaded", which is a setting and
-- distinct from `FAILED`, which is an error an admin can retry.
CREATE TYPE "DocumentDriveState" AS ENUM ('OFF', 'PENDING', 'COPIED', 'FAILED');

-- Explicit rather than inferred from which fields are null: three states that
-- read differently to a farmer should BE three states.
CREATE TYPE "DocumentPurgeReason" AS ENUM ('EXPIRED', 'DELETED');

-- ── FarmDocument ─────────────────────────────────────────────────────
--
-- `name` is ciphertext (ENCRYPTED_FIELDS). Nullable because a DELETED
-- tombstone CLEARS it: expiry is policy and the farm's index earns the name,
-- while a manual delete is a person's intent — usually "wrong file" — and
-- keeping it would preserve for good the one field encrypted BECAUSE it names
-- third parties.
--
-- `expiresOn` is a calendar DAY KEY, not a timestamp. The concept is a date,
-- so a timestamp would carry information the concept does not have and every
-- reader would then decide which day it meant. The CHECK is what makes that a
-- guarantee rather than a convention: no path, including a future one, can
-- write a malformed key.
CREATE TABLE IF NOT EXISTS "FarmDocument" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT NOT NULL,
    "name"             TEXT,
    "fileRecordId"     TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "retention"        "DocumentRetention" NOT NULL,
    "expiresOn"        TEXT,
    "purgedAt"         TIMESTAMP(3),
    "purgeReason"      "DocumentPurgeReason",
    "purgedByUserId"   TEXT,
    "driveState"       "DocumentDriveState" NOT NULL DEFAULT 'OFF',
    "driveFileId"      TEXT,
    "driveCopiedAt"    TIMESTAMP(3),
    "driveAttempts"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmDocument_pkey" PRIMARY KEY ("id"),

    -- A day key or nothing. Belt to the application's braces, because this
    -- column is compared as a STRING: a malformed value would not error, it
    -- would sort wrong, and a document would be swept early or never.
    CONSTRAINT "FarmDocument_expiresOn_daykey"
        CHECK ("expiresOn" IS NULL OR "expiresOn" ~ '^\d{4}-\d{2}-\d{2}$'),

    -- The three purge columns move together or not at all. A row with a
    -- reason and no timestamp, or a `purgedByUserId` on an EXPIRED sweep,
    -- would each be a state the client has no way to render.
    CONSTRAINT "FarmDocument_purge_is_coherent"
        CHECK (
            ("purgedAt" IS NULL AND "purgeReason" IS NULL AND "purgedByUserId" IS NULL)
            OR ("purgedAt" IS NOT NULL AND "purgeReason" = 'EXPIRED' AND "purgedByUserId" IS NULL)
            OR ("purgedAt" IS NOT NULL AND "purgeReason" = 'DELETED')
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS "FarmDocument_id_tenantId_key"
    ON "FarmDocument" ("id", "tenantId");
CREATE INDEX IF NOT EXISTS "FarmDocument_tenantId_idx"
    ON "FarmDocument" ("tenantId");
CREATE INDEX IF NOT EXISTS "FarmDocument_tenantId_createdAt_idx"
    ON "FarmDocument" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "FarmDocument_tenantId_purgedAt_idx"
    ON "FarmDocument" ("tenantId", "purgedAt");
CREATE INDEX IF NOT EXISTS "FarmDocument_tenantId_driveState_idx"
    ON "FarmDocument" ("tenantId", "driveState");
-- The sweep runs ACROSS tenants (`expiresOn <= today AND purgedAt IS NULL`),
-- so it needs an index that does not lead with tenantId. Layer A requires
-- only that AT LEAST one index does; this is an addition, not a replacement.
CREATE INDEX IF NOT EXISTS "FarmDocument_expiresOn_purgedAt_idx"
    ON "FarmDocument" ("expiresOn", "purgedAt");
CREATE INDEX IF NOT EXISTS "FarmDocument_fileRecordId_idx"
    ON "FarmDocument" ("fileRecordId");
CREATE INDEX IF NOT EXISTS "FarmDocument_uploadedByUserId_idx"
    ON "FarmDocument" ("uploadedByUserId");
CREATE INDEX IF NOT EXISTS "FarmDocument_purgedByUserId_idx"
    ON "FarmDocument" ("purgedByUserId");

ALTER TABLE "FarmDocument"
    ADD CONSTRAINT "FarmDocument_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FarmDocument"
    ADD CONSTRAINT "FarmDocument_fileRecordId_fkey"
    FOREIGN KEY ("fileRecordId") REFERENCES "FileRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FarmDocument"
    ADD CONSTRAINT "FarmDocument_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FarmDocument"
    ADD CONSTRAINT "FarmDocument_purgedByUserId_fkey"
    FOREIGN KEY ("purgedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── TenantDocumentSettings ───────────────────────────────────────────
--
-- One per tenant, the shape FarmProfile's docblock documents for a singleton:
-- `tenantId` unique, RLS trio below, no soft-delete.
CREATE TABLE IF NOT EXISTS "TenantDocumentSettings" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "retention" "DocumentRetention" NOT NULL DEFAULT 'P1Y',
    "driveSync" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantDocumentSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantDocumentSettings_tenantId_key"
    ON "TenantDocumentSettings" ("tenantId");

ALTER TABLE "TenantDocumentSettings"
    ADD CONSTRAINT "TenantDocumentSettings_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────
--
-- The standard trio, verbatim from 20261024170000_treatment_group_row: a USING
-- policy for reads, a SEPARATE insert policy with WITH CHECK, and the
-- superuser bypass. Deliberately NOT UserSession's single asymmetric policy —
-- that shape exists to stop an UPDATE rewriting a NULLABLE tenantId, and
-- neither of these tables has one.
ALTER TABLE "FarmDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FarmDocument" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "FarmDocument";
CREATE POLICY tenant_isolation ON "FarmDocument"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "FarmDocument";
CREATE POLICY tenant_isolation_insert ON "FarmDocument"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "FarmDocument";
CREATE POLICY superuser_bypass ON "FarmDocument"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "TenantDocumentSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantDocumentSettings" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "TenantDocumentSettings";
CREATE POLICY tenant_isolation ON "TenantDocumentSettings"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "TenantDocumentSettings";
CREATE POLICY tenant_isolation_insert ON "TenantDocumentSettings"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "TenantDocumentSettings";
CREATE POLICY superuser_bypass ON "TenantDocumentSettings"
    USING (current_setting('role') != 'app_user');
