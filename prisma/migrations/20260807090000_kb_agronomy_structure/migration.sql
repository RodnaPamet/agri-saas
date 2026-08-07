-- ═══════════════════════════════════════════════════════════════════
--  Knowledge Base — agronomy structure (crop / BBCH stage / region)
-- ═══════════════════════════════════════════════════════════════════
--
--  Adds crop/region/BBCH-stage applicability to KnowledgeArticle, and
--  mirrors crop/region/BBCH/language onto KnowledgeChunk so retrieval can
--  filter a chunk directly without joining back to its article. See the
--  "Agronomy structure" note in prisma/schema/knowledge.prisma for the
--  array-vs-join-table reasoning.
--
--  No RLS change — both tables already carry the correct policies from
--  20260614211943_knowledge_base / 20260619100000_ai_rag_pgvector; this
--  migration only adds columns + one supporting index.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable: KnowledgeArticle
ALTER TABLE "KnowledgeArticle"
    ADD COLUMN "cropTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "regions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "bbchStageMin" INTEGER,
    ADD COLUMN "bbchStageMax" INTEGER;

-- AlterTable: KnowledgeChunk
ALTER TABLE "KnowledgeChunk"
    ADD COLUMN "language" TEXT,
    ADD COLUMN "cropTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "regions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "bbchStageMin" INTEGER,
    ADD COLUMN "bbchStageMax" INTEGER;

-- CreateIndex — backs the language-aware retrieval WHERE clause
-- (ai/rag/retrieve.ts keyword branch); Layer A is already satisfied by
-- the existing [tenantId, articleId] index.
CREATE INDEX "KnowledgeChunk_tenantId_language_idx" ON "KnowledgeChunk"("tenantId", "language");

SELECT 'Knowledge Base agronomy structure installed' AS result;
