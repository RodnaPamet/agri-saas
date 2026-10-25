-- #2316 — a non-chemical activity is a line like any other.
--
-- «ДНЕВНИК НА СТОПАНСТВОТО» is a whole-farm campaign journal covering EVERY
-- activity, not only spraying: pruning, cultivation, sowing and harvest all
-- print in it. None of those applies a product, and `OperationParcel` had
-- `productItemId`, `doseValue` and `doseUnitId` all NOT NULL — so an activity
-- without a product could not be recorded as a line at all. There was nowhere
-- to put "pruned 3 of 8 ha on this parcel".
--
-- ## Why this table and not a sibling one
--
-- Two alternatives were considered and rejected (owner decision 2026-10-25):
--
--   - A separate `FarmActivityParcel` table would leave the regulated БАБХ path
--     untouched, at the cost of a union in both the journal gatherer and the
--     PDF, and a future column landing on one table only.
--   - Writing `TaskLinkEntityType.PARCEL` — which exists in the enum and is
--     never written, measured across every `entityType:` literal in the repo —
--     needs no migration, but `TaskLink` carries no treated area. "Pruned 3 of
--     8 ha" would be unrecordable, and that is exactly the column the paper
--     form prints. The shape cannot express the document.
--
-- ## The CHECK is what the NOT NULLs were actually protecting
--
-- Relaxing three columns individually would admit a chemical line with a
-- product and no dose. `num_nulls` keeps them all-or-nothing, so a line is
-- either a complete product application or carries none of the three. A row
-- with a product but no dose stays impossible, which is the property that
-- mattered — the NOT NULLs were a crude way of spelling it.
--
-- `num_nulls` is a Postgres builtin (9.6+), so no extension is involved.
--
-- Deliberately NOT extended to `quarantinePeriodDays`, `phenophase` or the
-- water-rate pair. Those are already nullable and already mean "not captured"
-- rather than "zero" (#1775, #2072). Folding them in would turn a missing
-- observation into a constraint violation on rows that predate the columns.
--
-- ## Why the partial unique index
--
-- `OperationParcel_taskId_parcelId_productItemId_key` is per PRODUCT, because a
-- spray job legitimately records a fertilizer line AND a treatment line on the
-- same parcel. Postgres treats NULLs as DISTINCT in a unique index, so the
-- moment `productItemId` goes nullable that constraint stops constraining bare
-- activity rows entirely: two identical pruning lines on one parcel in one task
-- would both be accepted, and the journal would print the work twice.
--
-- There is nothing to distinguish two bare lines on the same (task, parcel) —
-- no product is the whole point — so one is the right number, and a PARTIAL
-- unique index says exactly that while costing nothing on product rows.
--
-- Prisma cannot express a partial index, so it lives here and the client is
-- unaware — the same arrangement as `PushSubscription`'s iOS token index
-- (#1764) and `ContentReport`'s partial `[alertedAt, createdAt]`. A future
-- `prisma migrate diff` will want to "fix" the apparent absence; it must not.
--
-- ## No rollback script
--
-- `deploy/rollback/README.md`: a script is needed when a migration renames,
-- drops or narrows something the previous image still uses. This only WIDENS.
-- The previous image writes all three columns on every insert, so it satisfies
-- the CHECK (`num_nulls = 0`) and never touches the partial index, whose
-- predicate matches no row it can create. An image-only rollback degrades
-- gracefully.

ALTER TABLE "OperationParcel"
    ALTER COLUMN "productItemId" DROP NOT NULL,
    ALTER COLUMN "doseValue" DROP NOT NULL,
    ALTER COLUMN "doseUnitId" DROP NOT NULL;

ALTER TABLE "OperationParcel"
    ADD CONSTRAINT "OperationParcel_dose_all_or_nothing"
    CHECK (num_nulls("productItemId", "doseValue", "doseUnitId") IN (0, 3));

CREATE UNIQUE INDEX "OperationParcel_taskId_parcelId_bare_activity_key"
    ON "OperationParcel" ("taskId", "parcelId")
    WHERE "productItemId" IS NULL;


-- ── «ДНЕВНИК НА СТОПАНСТВОТО»'s header needs област ──────────────────────────
--
-- The template's header is four lines: holder, село, община, област.
-- `FarmProfile` carried the first three (`producerName`, `settlement`,
-- `municipality`) and nothing for the fourth.
--
-- An `oblast` does exist on the public-profile models, and reading it from
-- there is the shortcut to avoid: it would make a regulated document's header
-- depend on whether a farm published a public profile, and none has — 0
-- `PublicFarmProfile` rows, 0 published `FarmBrand`, 0 indexable, measured
-- 2026-10-25. Every header would have rendered blank while looking wired up.
--
-- Nullable like every sibling address field: the paper form tolerates a blank,
-- and a farm that has not filled its profile must still be able to print.

ALTER TABLE "FarmProfile" ADD COLUMN "oblast" TEXT;


-- ── the three activity kinds the form prints and the enum lacked ────────────
--
-- The form names six activities: sprayings, fertilising, pruning, cultivation,
-- sowing, harvest. Three already had a value — SPRAY, FERTILIZE, and SEED,
-- which IS сеитба — so this adds three, not six, and no parallel vocabulary.
--
-- `ADD VALUE` inside a transaction is allowed from Postgres 12 (this runs on
-- 16) provided the new value is not USED in the same transaction. Nothing
-- below uses them, so the migration commits cleanly; a later migration that
-- wanted to write one of these would need its own.

ALTER TYPE "FieldOperationType" ADD VALUE 'PRUNE';
ALTER TYPE "FieldOperationType" ADD VALUE 'CULTIVATE';
ALTER TYPE "FieldOperationType" ADD VALUE 'HARVEST';
