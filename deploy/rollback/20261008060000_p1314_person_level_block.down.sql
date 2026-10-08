-- Inverse of 20261008060000_p1314_person_level_block.
--
-- WHY THIS FILE EXISTS. The forward migration RENAMES a column, so pinning
-- Watchtower back reverts the CODE and leaves the SCHEMA migrated: the previous
-- image queries `ExchangeBlock.blockedTenantId`, which no longer exists. An
-- image-only rollback does not degrade, it fails outright — every exchange
-- block read errors, and a block read is on the send path.
--
-- Without this file the only remaining lever is a snapshot restore: daily at
-- 02:00 UTC, so up to 24 hours of farm data discarded to undo a messaging
-- change (see docs/backup-restore.md). This makes rollback a rename instead —
-- no rows move, nothing is lost.
--
-- WHAT IT CANNOT UNDO, and the operator should know before running it: any
-- block created while the person-level code was live holds a USER id in that
-- column. Renaming it back puts a user id where a tenant id is expected, and
-- the old code will compare it against `inquirerTenantId` and never match — so
-- those blocks silently stop refusing anyone rather than erroring. They are not
-- lost, and re-applying the forward migration restores them exactly. If any
-- exist, the honest sequence is to roll forward again rather than leave a block
-- that looks present and does nothing.
--
--   SELECT count(*) FROM "ExchangeBlock";
--
-- was ZERO in production when the forward migration was written, so this is
-- hypothetical on day one and will not stay that way.
--
-- Prisma has no down-migrations, so this is deliberately NOT a migration
-- directory. It is a psql script an operator runs by hand.

BEGIN;

ALTER TABLE "ExchangeBlock" RENAME COLUMN "blockedUserId" TO "blockedTenantId";

ALTER INDEX IF EXISTS "ExchangeBlock_sellerTenantId_blockedUserId_key"
    RENAME TO "ExchangeBlock_sellerTenantId_blockedTenantId_key";
ALTER INDEX IF EXISTS "ExchangeBlock_blockedUserId_idx"
    RENAME TO "ExchangeBlock_blockedTenantId_idx";

-- Restore the tenant-scoped read arm the forward migration replaced.
DROP POLICY IF EXISTS exchange_block_select ON "ExchangeBlock";
CREATE POLICY exchange_block_select ON "ExchangeBlock"
    FOR SELECT
    USING (
        "sellerTenantId"  = current_setting('app.tenant_id', true)::text
        OR "blockedTenantId" = current_setting('app.tenant_id', true)::text
    );

-- ── Prisma bookkeeping ───────────────────────────────────────────────
-- Load-bearing; see the header. Without this, a later roll-forward sees the
-- rename as already applied and skips it, leaving new code on an old schema.
DELETE FROM "_prisma_migrations"
 WHERE "migration_name" = '20261008060000_p1314_person_level_block';

COMMIT;
