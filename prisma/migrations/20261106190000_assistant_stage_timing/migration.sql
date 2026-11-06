-- #2751 — persist `assistant.stage_timing`, which until now existed only in
-- the current container's log and was destroyed by every Watchtower prune.
-- Measured on production 2026-11-06: ZERO rows available, against ~20
-- answered questions all-time. The figures the per-round model decision needs
-- were being destroyed faster than they accumulated.

-- CreateTable
CREATE TABLE "AssistantStageTiming" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "totalMs" INTEGER NOT NULL,
    "providerMs" INTEGER NOT NULL,
    "providerCalls" INTEGER NOT NULL,
    "toolSelectMs" INTEGER NOT NULL,
    "answerMs" INTEGER NOT NULL,
    "toolPhaseMs" INTEGER NOT NULL,
    "otherMs" INTEGER NOT NULL,
    "toolCallsMade" INTEGER NOT NULL,
    "halt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantStageTiming_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Layer A (tenantId-leading) and the shape every read wants: one farm's
-- timings over a window. Also what the retention sweep deletes by.
CREATE INDEX "AssistantStageTiming_tenantId_createdAt_idx" ON "AssistantStageTiming"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "AssistantStageTiming" ADD CONSTRAINT "AssistantStageTiming_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — the canonical trio for a tenant-scoped table.
--  `tenantId` is NON-null, so the split tenant_isolation (USING) +
--  tenant_isolation_insert (WITH CHECK) form applies, matching
--  AiUsageEvent / PushSubscription / KnowledgeArticle rather than the
--  single asymmetric policy UserSession needs for its NULLABLE column.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AssistantStageTiming']
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
