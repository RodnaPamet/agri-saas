-- ═══════════════════════════════════════════════════════════════════
--  PayrollExpense → CostEntry(PAYROLL)
--
--  /grain/costs became the register where every kind of cost is entered,
--  so payroll is a CATEGORY there rather than its own surface. The grain
--  net-worth calculator now reads CostEntry for its payroll line, which
--  means any PayrollExpense row left behind would silently stop reaching
--  the figure it used to feed. This copies them across.
--
--  ── Why the source table is LEFT IN PLACE ──────────────────────────
--
--  This migration is purely ADDITIVE: it inserts rows and drops nothing.
--  `prisma migrate deploy` runs from the container entrypoint, so
--  shipping an image is what applies a migration — and pinning Watchtower
--  back would revert the CODE while leaving the SCHEMA migrated. A DROP
--  here would leave the previous image querying a table that no longer
--  exists, turning an image-only rollback into a restore-from-snapshot.
--  Keeping the table means a rollback needs no inverse script at all
--  (deploy/rollback/README.md's rule), at the cost of one dormant table
--  that a later, separate migration can remove once the new surface has
--  proven itself.
--
--  ── Idempotency ────────────────────────────────────────────────────
--
--  Keyed on the ORIGINAL id: a CostEntry minted here reuses the
--  PayrollExpense id verbatim. That makes a re-run a no-op via the NOT
--  EXISTS guard, and it also means the audit trail of the old row and the
--  new one share an entity id, so a support query can follow one thread.
--  Soft-deleted rows are skipped — copying them would resurrect spend the
--  farmer deliberately removed.
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO "CostEntry" (
    "id", "tenantId", "category", "amount", "currency", "incurredOn",
    "supplier", "description", "invoiceFileId",
    "plantingId", "seasonId", "locationId", "parcelId", "leaseId",
    "createdByUserId", "createdAt", "updatedAt",
    "deletedAt", "deletedByUserId", "retentionUntil"
)
SELECT
    p."id",
    p."tenantId",
    'PAYROLL'::"CostCategory",
    p."amount",
    p."currency",
    p."incurredOn",
    NULL,               -- PayrollExpense had no supplier column
    p."description",    -- already ciphertext; copied verbatim, never re-encrypted
    NULL,               -- and no invoice
    p."plantingId",
    p."seasonId",
    NULL, NULL, NULL,   -- location / parcel / lease: not expressible before
    p."createdByUserId",
    p."createdAt",
    p."updatedAt",
    p."deletedAt",
    p."deletedByUserId",
    p."retentionUntil"
FROM "PayrollExpense" p
WHERE p."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "CostEntry" c WHERE c."id" = p."id");
