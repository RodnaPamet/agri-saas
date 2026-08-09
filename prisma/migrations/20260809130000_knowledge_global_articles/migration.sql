-- ═══════════════════════════════════════════════════════════════════
--  W5 (final task) — GLOBAL KnowledgeArticle / KnowledgeArticleVersion
-- ═══════════════════════════════════════════════════════════════════
--
--  Makes `KnowledgeArticle.tenantId` and `KnowledgeArticleVersion.tenantId`
--  NULLABLE. NULL = GLOBAL, platform-authored content (starting with the
--  satellite-imagery guide, seeded by scripts/rag/ingest-satellite-guide.ts
--  under the superuser-bypassed default Prisma client) — readable by
--  EVERY tenant. Non-null = tenant-private, unchanged behaviour. Mirrors
--  `KnowledgeChunk` (20260619100000_ai_rag_pgvector) and `UserSession`
--  (20260423150000_epic_d1_user_session_rls) — read BOTH of those
--  migrations for the full "why".
--
--  `KnowledgeAcknowledgement` is DELIBERATELY UNTOUCHED here — it stays
--  NOT NULL tenantId with the canonical split tenant_isolation +
--  tenant_isolation_insert policy pair. An acknowledgement always belongs
--  to the ACTING tenant, never to a GLOBAL one; its composite FK
--  (articleVersionId, tenantId) -> KnowledgeArticleVersion(id, tenantId)
--  requires an EXACT tenantId match, so the DB itself refuses an attempt
--  to acknowledge a GLOBAL article version (no KnowledgeArticleVersion
--  row ever has tenantId = <a real tenant> AND id = <a GLOBAL version's
--  id>). The usecase layer (`acknowledgeArticle` in
--  src/app-layer/usecases/knowledge.ts) rejects it first with a clear
--  typed error; this FK is the independent DB-layer backstop.
--
--  ─── Why the single-policy form (NOT a split read/insert pair) ───
--  `tenantId` is nullable on both tables below. A split
--  `tenant_isolation_insert` FOR INSERT WITH CHECK would be a PERMISSIVE
--  sibling policy — Postgres ORs permissive policies together, and a
--  permissive policy without its own WITH CHECK implicitly grants
--  WITH CHECK (true) on UPDATE for visible rows. Net effect: app_user
--  could UPDATE a NULL-tenant GLOBAL row to claim it for ANY tenant.
--  Combining the asymmetric `USING (NULL OR own)` with the strict
--  `WITH CHECK (own)` on a SINGLE policy closes that leak — see the
--  UserSession migration's header for the long-form rationale. Same
--  shape already proven on KnowledgeChunk / UserSession /
--  IntegrationWebhookEvent.
--
--  ─── Slug uniqueness ───
--  `@@unique([tenantId, slug])` (kept, unchanged) no longer prevents two
--  GLOBAL articles from sharing a slug — Postgres treats NULLs as
--  distinct within a unique index. A partial unique index on
--  `slug WHERE "tenantId" IS NULL` covers that case. Hand-authored (like
--  the KnowledgeChunk ivfflat vector index) because Prisma's schema DSL
--  has no `@@unique(..., where: ...)`.
--
--  Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- ─── nullable tenantId ───
ALTER TABLE "KnowledgeArticle" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "KnowledgeArticleVersion" ALTER COLUMN "tenantId" DROP NOT NULL;

-- ─── slug uniqueness among GLOBAL rows only ───
DROP INDEX IF EXISTS "KnowledgeArticle_slug_global_key";
CREATE UNIQUE INDEX "KnowledgeArticle_slug_global_key"
    ON "KnowledgeArticle"("slug")
    WHERE "tenantId" IS NULL;

-- ═══════════════════════════════════════════════════════════════════
--  Row-Level Security — replace the canonical split-policy pair with
--  the single asymmetric policy on KnowledgeArticle + KnowledgeArticleVersion.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['KnowledgeArticle', 'KnowledgeArticleVersion']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Drop the old split-policy pair — the asymmetric single policy
    -- below replaces both.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);

    EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I ' ||
        'USING ("tenantId" IS NULL OR "tenantId" = current_setting(''app.tenant_id'', true)::text) ' ||
        'WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::text)',
        t
    );

    EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', t);
    EXECUTE format('CREATE POLICY superuser_bypass ON %I USING (current_setting(''role'') != ''app_user'')', t);
  END LOOP;
END
$$;

SELECT 'Knowledge global articles installed' AS result;
