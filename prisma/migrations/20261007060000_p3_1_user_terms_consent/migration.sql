-- P3.1 — record which terms a user accepted, and when.
--
-- Two nullable columns, no default and no backfill. That is the whole design
-- decision: every user who registered before this shipped genuinely has no
-- consent record, and a DEFAULT would manufacture one. A null here means "we
-- do not know whether this person accepted anything", which is true and is
-- what a reader should take from it.
--
-- `acceptedTermsVersion` is text rather than an enum so a row stays readable
-- after the current version moves on. The column records what the person SAW,
-- which is a historical fact; an enum would force every superseded value to
-- remain a member of the live type.
--
-- Purely additive, so the previous image keeps working against this schema and
-- no inverse script is needed under deploy/rollback/ — that convention covers
-- renames, drops, and rewrites of persisted data still read.
ALTER TABLE "User" ADD COLUMN "acceptedTermsAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "acceptedTermsVersion" TEXT;
