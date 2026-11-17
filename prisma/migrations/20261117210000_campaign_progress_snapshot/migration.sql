-- #3173: МЗХ field-campaign progress, one row per weekly bulletin. Global
-- reference data (no tenant), additive.
CREATE TABLE "CampaignProgressSnapshot" (
    "id" TEXT NOT NULL,
    "bulletinDate" DATE NOT NULL,
    "asOf" DATE NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "tablesJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignProgressSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignProgressSnapshot_bulletinDate_key" ON "CampaignProgressSnapshot"("bulletinDate");
CREATE INDEX "CampaignProgressSnapshot_asOf_idx" ON "CampaignProgressSnapshot"("asOf");
