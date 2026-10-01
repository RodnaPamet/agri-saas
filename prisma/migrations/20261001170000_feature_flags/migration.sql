-- P0.4 — runtime feature flags and cohorts. Platform-scoped, not tenant-scoped.
--
-- These tables ship ONE RELEASE BEFORE the code that writes them, per the P0
-- preamble, so a rollback of the writing code never leaves a missing table.
--
-- Default OFF is the whole point: a flag that does not exist is off, and a flag
-- that exists is off until someone enables it. There is no "default on" path.
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    -- NON-EMPTY narrows the rollout: `enabled` AND cohort membership. Empty
    -- means everyone once enabled. The AND is load-bearing — read as OR, an
    -- enabled flag with cohorts set would expose the surface to everyone.
    "cohorts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,
    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "FeatureFlag_enabled_idx" ON "FeatureFlag"("enabled");

CREATE TABLE "FeatureFlagCohortMember" (
    "id" TEXT NOT NULL,
    "cohortKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureFlagCohortMember_pkey" PRIMARY KEY ("id")
);

-- A double-add is a no-op rather than two rows.
CREATE UNIQUE INDEX "FeatureFlagCohortMember_cohortKey_userId_key"
    ON "FeatureFlagCohortMember"("cohortKey", "userId");
-- The resolver asks "which cohorts is this user in" on every request.
CREATE INDEX "FeatureFlagCohortMember_userId_idx" ON "FeatureFlagCohortMember"("userId");
CREATE INDEX "FeatureFlagCohortMember_cohortKey_idx" ON "FeatureFlagCohortMember"("cohortKey");

ALTER TABLE "FeatureFlagCohortMember"
    ADD CONSTRAINT "FeatureFlagCohortMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
