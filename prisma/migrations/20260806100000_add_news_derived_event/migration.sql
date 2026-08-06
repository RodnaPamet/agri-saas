-- Calendar roadmap PR 3 — AI news-derived calendar-event proposals.
--
-- Adds `NewsDerivedEvent`: extracted daily from GLOBAL policy-category
-- `MarketNewsItem` headlines by the `news-event-extraction` job (Claude
-- Haiku). NO tenantId — like `AgriEvent`/`MarketNewsItem`, a subsidy
-- deadline or regulation date is the same fact for every tenant, so this
-- table needs no RLS and is absent from `TENANT_SCOPED_MODELS`.
--
-- `sourceNewsItemId` is a plain identity column, not a foreign key — see
-- the model doc in prisma/schema/agriculture.prisma for why a hard FK to
-- the 60-day-pruned MarketNewsItem table would be wrong here.
--
-- A row starts PROPOSED and is invisible to every tenant until a
-- platform admin promotes it to APPROVED (or REJECTED) — see
-- docs/implementation-notes/2026-08-06-ai-news-calendar-events.md.

-- CreateEnum
CREATE TYPE "NewsDerivedEventStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "NewsDerivedEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sourceExcerpt" TEXT NOT NULL,
    "sourceNewsItemId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "status" "NewsDerivedEventStatus" NOT NULL DEFAULT 'PROPOSED',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsDerivedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsDerivedEvent_sourceNewsItemId_kind_key" ON "NewsDerivedEvent"("sourceNewsItemId", "kind");

-- CreateIndex
CREATE INDEX "NewsDerivedEvent_status_eventDate_idx" ON "NewsDerivedEvent"("status", "eventDate");
