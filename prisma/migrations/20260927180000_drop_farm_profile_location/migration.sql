-- `farmLocation` was a duplicate of `registrationPlace`, added on a misreading.
--
-- "Location" on this page means WHERE THE FARM IS REGISTERED — which the form
-- calls «Място на регистриране» and this table has held as `registrationPlace`
-- since the ДНЕВНИК work. The new column was documented as "where the land is,
-- distinct from the correspondence address", which is the opposite of what was
-- asked for, and nothing else on the form means that.
--
-- COPY BEFORE DROP. The field shipped and was editable, so a value may have
-- been typed into it; it would be the same string a person would put in
-- `registrationPlace`. Move it across only where the destination is empty, so
-- an existing registration place is never overwritten.
UPDATE "FarmProfile"
   SET "registrationPlace" = "farmLocation"
 WHERE "farmLocation" IS NOT NULL
   AND btrim("farmLocation") <> ''
   AND COALESCE(btrim("registrationPlace"), '') = '';

ALTER TABLE "FarmProfile" DROP COLUMN "farmLocation";
