-- Soft delete for a parcel note (owner ruling 2026-11-06: the author, or a
-- farm ADMIN/OWNER, may remove one).
--
-- A separate migration rather than an edit to 20261106194007_parcel_comment,
-- which is in the same pull request: editing an applied migration changes its
-- recorded checksum, and `prisma migrate` then refuses to run anywhere the
-- first one has already been applied. Two additive migrations for one new
-- table is cosmetic; a checksum conflict is not.
--
-- No RLS change is needed. The policies on this table are keyed on `tenantId`
-- alone, and a soft delete is an UPDATE of a row the caller can already see,
-- so `tenant_isolation` governs it unchanged. There is no `app_user` DELETE
-- arm to add, because nothing hard-deletes a note.
ALTER TABLE "ParcelComment" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Partial, because every read is "the live notes on this parcel". A plain
-- three-column index would also carry the deleted rows, which are exactly the
-- ones no query wants.
CREATE INDEX "ParcelComment_tenantId_parcelId_live_idx"
    ON "ParcelComment" ("tenantId", "parcelId")
    WHERE "deletedAt" IS NULL;
