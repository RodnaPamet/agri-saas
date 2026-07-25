-- Contract number (`key`) — soft-delete-aware uniqueness
--
-- `Contract.key` is the reference printed on the paper the farmer is
-- holding, and it carries a real `@@unique([tenantId, key])`. That index
-- was NOT soft-delete-aware, so deleting a contract permanently burned
-- its number: re-entering the same reference (a re-issued or corrected
-- contract, the ordinary case) hit a 409 the operator could neither see
-- nor diagnose, because the colliding row was invisible to them.
--
-- Same treatment Asset.name / Policy.slug already got in
-- 20260312210616_partial_unique_soft_delete: uniqueness applies to LIVE
-- rows only. Prisma cannot express a partial index, so `@@unique` stays
-- in the schema (it is the logical constraint) and the partial form is
-- applied here — the documented, pre-existing divergence.

DROP INDEX IF EXISTS "Contract_tenantId_key_key";
CREATE UNIQUE INDEX "Contract_tenantId_key_key"
    ON "Contract"("tenantId", "key")
    WHERE "deletedAt" IS NULL;
