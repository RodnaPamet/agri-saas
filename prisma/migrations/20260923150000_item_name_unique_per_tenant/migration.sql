-- One product name per tenant (#1078).
--
-- `Item` carried `@@index([tenantId, name])` — an index, not a constraint —
-- and `createItem` performed no existence check, so a duplicate was accepted
-- silently. That is not hypothetical: production holds two rows both named
-- `Roubdup`, created minutes apart, the only real products anyone has ever
-- entered. Sprays filed against both would split one product's history across
-- two ids with no way to tell from the register.
--
-- ── Step 1: retire duplicates that nothing references ──
--
-- Ranked per (tenant, lower(name)): the row with the most references wins,
-- ties broken by age. Only NON-winners with ZERO references are retired, so
-- this can never detach a spray line, a lot or a cost entry from its product.
--
-- If a group still holds two live rows after this — both referenced — the
-- index below FAILS and the deploy stops. That is deliberate: choosing which
-- of two used products survives is a decision for a person, not a migration.
--
-- Soft delete, not DELETE. `Item` has `deletedAt` and every read filters on
-- it, so this is reversible by clearing one column.
WITH ranked AS (
    SELECT i.id,
           i."tenantId",
           lower(i."name") AS lname,
           i."createdAt",
           (SELECT count(*) FROM "OperationParcel" o WHERE o."productItemId" = i.id)
         + (SELECT count(*) FROM "InventoryLot"    l WHERE l."itemId"        = i.id)
         + (SELECT count(*) FROM "CostEntry"       c WHERE c."itemId"        = i.id) AS refs
    FROM "Item" i
    WHERE i."deletedAt" IS NULL
),
grouped AS (
    SELECT id, refs,
           row_number() OVER (PARTITION BY "tenantId", lname ORDER BY refs DESC, "createdAt" ASC) AS rn,
           count(*)     OVER (PARTITION BY "tenantId", lname)                                     AS grp
    FROM ranked
)
UPDATE "Item"
SET "deletedAt" = now()
WHERE id IN (SELECT id FROM grouped WHERE grp > 1 AND rn > 1 AND refs = 0);

-- ── Step 2: the constraint ──
--
-- PARTIAL (`WHERE "deletedAt" IS NULL`) so a retired name can be used again.
-- Without that, deleting a mistyped product would reserve its name forever —
-- and the row this migration retires is a misspelling someone will want to
-- correct.
--
-- CASE-INSENSITIVE, because `Roundup` and `roundup` are the same accident as
-- `Roubdup` twice, and a product's trade name is not case-meaningful. This is
-- the stricter of the two readings; relaxing it later means dropping the
-- index and creating it on `"name"` instead.
--
-- Raw SQL because Prisma expresses neither a partial index nor an expression
-- index. The schema documents it beside the model rather than declaring it.
CREATE UNIQUE INDEX "Item_tenantId_name_active_key"
    ON "Item" ("tenantId", lower("name"))
    WHERE "deletedAt" IS NULL;
