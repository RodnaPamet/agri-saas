-- #1530 (2026-10-10) — a farmer-typed per-crop cost can reach the margin.
--
-- `cashCostTotal` took `CostEntry` only for PAYROLL, and a parcel resolved to a
-- commodity only through a Planting. So a farmer who typed a лв/дка figure for
-- wheat had it reach nothing: recorded, listed, and absent from every
-- per-commodity cost, margin and break-even figure on the calculator.
--
-- Owner decisions 2026-10-10:
--   · fold it into the margin, EXCLUSIVE per crop+season;
--   · the season is the Season containing `incurredOn`, else its calendar year;
--   · the discriminator is a DEDICATED MARKER on the entry, not an inference
--     from `amountPerDca` or the category — an inferred rule would reclassify
--     existing rows the moment it changed;
--   · where a crop+season has both a typed figure and a consumption-derived
--     one, the TYPED figure wins.
--
-- Two additive changes. No existing row moves: `allocationBasis` keeps its
-- `TARGET` default and `commodityCanonical` is NULL everywhere until a farmer
-- picks a crop on a new entry.
--
-- `IF NOT EXISTS` mirrors
-- `20260524150000_audit_s7_access_review_escalation`. Hand-authored per repo
-- convention — `migrate dev --create-only` injects unrelated pre-existing
-- drift (see `20260614194014_inventory_lot_genealogy`).
--
-- NO inverse script in `deploy/rollback/`: both statements are additive, so
-- the previous image keeps working unchanged. It never writes `CROP` and never
-- reads the new column. The one thing an image rollback cannot undo is a row
-- already written with `allocationBasis = 'CROP'` — the old image's generated
-- client has no such member, so it would surface as an unexpected enum value
-- on read. That is the standard additive-enum exposure and the repo's rule
-- names only renames, drops and data rewrites as needing an inverse.

-- AlterEnum
ALTER TYPE "CostAllocationBasis" ADD VALUE IF NOT EXISTS 'CROP';

-- AlterTable
ALTER TABLE "CostEntry" ADD COLUMN "commodityCanonical" TEXT;
