-- Drop FarmProfile.egn — the product does not hold a national identity number.
--
-- Owner ruling 2026-10-24. The column existed because the prescribed БАБХ form
-- (Прил. 1 към заповед РД 11-3194/31.12.2021) has a boxed ЕГН field on its
-- cover and the model mirrored the paper; the ruling is that mirroring the form
-- is not a reason to hold one. The cover now prints ЕИК and УРН instead.
--
-- TWO statements, and the order is the point.
--
-- `DROP COLUMN` alone does NOT remove the bytes: Postgres marks the attribute
-- dropped in the catalog, and every existing heap tuple still physically
-- carries the value until that row is rewritten. The UPDATE rewrites every
-- row first, so from here on every LIVE tuple is free of the value and any
-- later rewrite — VACUUM FULL, pg_repack, a dump-and-restore — carries nothing
-- forward. The old tuple versions hold ciphertext until autovacuum reclaims
-- them, so this is not a cryptographic shred and is not claimed as one; what
-- it is, is the strongest thing a migration can do without an exclusive-lock
-- table rewrite on a live database.
--
-- The values were encrypted at rest under a per-tenant DEK
-- (src/lib/security/encrypted-fields.ts), which is why the residue above is an
-- acceptable risk rather than a plaintext leak. The manifest entry is removed
-- in the same change; `egn` is not a column name on any other model, so no
-- other table's ciphertext is orphaned by that.
UPDATE "FarmProfile" SET "egn" = NULL WHERE "egn" IS NOT NULL;

ALTER TABLE "FarmProfile" DROP COLUMN "egn";
