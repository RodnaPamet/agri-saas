-- The holding's own identity, beside the producer's.
--
-- `urn` is the МЗХ земеделски-стопанин registration number — distinct from
-- `eik` (company) and `egn` (person), which were already here. It is encrypted
-- at rest by the application manifest, so this column holds ciphertext.
--
-- `sizeHa` is DECLARED, not derived. The parcels already sum to an area; that
-- sum and this number may legitimately disagree, and the paper form needs the
-- declared one.
ALTER TABLE "FarmProfile" ADD COLUMN "urn" TEXT;
ALTER TABLE "FarmProfile" ADD COLUMN "sizeHa" DECIMAL(12,3);
ALTER TABLE "FarmProfile" ADD COLUMN "grainProduced" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "FarmProfile" ADD COLUMN "farmLocation" TEXT;
