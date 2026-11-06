-- ParcelComment — a note about a PARCEL, tied to no task.
--
-- «Коментари» on the parcel history page (owner ruling 2026-11-06). Free text
-- about the field itself, which has no task to hang off.
--
-- `body` is in ENCRYPTED_FIELDS, so it stores a `v2:` envelope under the FARM's
-- DEK. Every read must therefore run inside a tenant context; a privileged read
-- returns ciphertext silently (#2723).
CREATE TABLE "ParcelComment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clientMutationId" TEXT,

    CONSTRAINT "ParcelComment_pkey" PRIMARY KEY ("id")
);

-- Offline exactly-once: the phone replays a queued note with its outbox item id
-- as the Idempotency-Key. Nullable, so a normal online write is unconstrained —
-- every NULL is unique to Postgres.
CREATE UNIQUE INDEX "ParcelComment_tenantId_clientMutationId_key"
    ON "ParcelComment"("tenantId", "clientMutationId");

-- The only read shape: one parcel's notes, newest first. Layer A is satisfied
-- by the tenantId-leading composite; Layer B wants every FK scalar indexed and
-- `parcelId` is the second column of this one, which that layer accepts for a
-- tenant model. `createdByUserId` is a 1:1 pointer never reverse-queried —
-- there is no "notes by this user" view — so it takes no index of its own.
CREATE INDEX "ParcelComment_tenantId_parcelId_idx" ON "ParcelComment"("tenantId", "parcelId");

ALTER TABLE "ParcelComment" ADD CONSTRAINT "ParcelComment_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite to the parcel, matching ParcelCropSeason: the FK carries tenantId
-- so a row cannot point at another farm's parcel even if the id were guessed.
ALTER TABLE "ParcelComment" ADD CONSTRAINT "ParcelComment_parcelId_tenantId_fkey"
    FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ParcelComment" ADD CONSTRAINT "ParcelComment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  RLS. `tenantId` is NON-null, so the split tenant_isolation (USING) +
--  tenant_isolation_insert (WITH CHECK) form applies — the same shape as
--  AssistantStageTiming / AiUsageEvent / TaskComment, rather than the single
--  asymmetric policy UserSession needs for its NULLABLE column.
--
--  FORCE, not merely ENABLE: without it the table owner bypasses its own
--  policies, and `rls-coverage` asserts both.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ParcelComment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON %I FOR INSERT WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', t);
    EXECUTE format('CREATE POLICY superuser_bypass ON %I USING (current_setting(''role'') != ''app_user'')', t);
  END LOOP;
END
$$;
