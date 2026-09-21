-- The БАБХ diary's per-field header needs three values the Parcel model had
-- nowhere to hold: Землище, Местност and Склад за растителна продукция.
--
-- Two of the three are ALREADY IMPORTED and simply unread. Parcels arrive via
-- two different paths with different key spellings for the same concepts:
--
--   КАИС ownership import   EKATTE, NAME, SUBJ_NAME, EGN_BSTAT
--                           -> carries neither местност nor землище
--   spatial import          ekate, mestnost, virtual_ek, masiv
--                           -> carries BOTH, as free text
--
-- So the backfill below populates the spatial-import parcels for free and
-- leaves the КАИС ones blank for hand entry. A farmer retyping data the
-- import already delivered would be the worse outcome.
--
-- `virtual_ek` is "Дерманци (20688)" — settlement name AND code together,
-- which is exactly what the form's Землище field asks for, so it is taken
-- verbatim rather than split.
ALTER TABLE "Parcel" ADD COLUMN "landDistrict" TEXT;
ALTER TABLE "Parcel" ADD COLUMN "locality"     TEXT;
ALTER TABLE "Parcel" ADD COLUMN "produceStore" TEXT;

-- Only fills NULLs, so a re-run can never overwrite something hand-entered.
-- Empty strings in the import become NULL rather than a blank that looks
-- filled in: the diary prints an empty cell either way, but a NULL says
-- "never supplied" where '' says "supplied as nothing".
UPDATE "Parcel"
   SET "locality" = NULLIF(TRIM("propertiesJson" ->> 'mestnost'), '')
 WHERE "locality" IS NULL
   AND "propertiesJson" IS NOT NULL
   AND NULLIF(TRIM("propertiesJson" ->> 'mestnost'), '') IS NOT NULL;

UPDATE "Parcel"
   SET "landDistrict" = NULLIF(TRIM("propertiesJson" ->> 'virtual_ek'), '')
 WHERE "landDistrict" IS NULL
   AND "propertiesJson" IS NOT NULL
   AND NULLIF(TRIM("propertiesJson" ->> 'virtual_ek'), '') IS NOT NULL;
