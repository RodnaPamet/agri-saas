-- Allow several insurance asks per parcel.
--
-- The unique on (parcelId, inquirerTenantId) made an ask once-only with no
-- withdraw and no edit: a second POST hit P2002 and became a 409. That was
-- tolerable while the ask was a one-tap confirmation, and stopped being so
-- when the form began collecting the farmer's own land size — a figure they
-- may get wrong the first time, and could not then correct.
--
-- The owner chose repeat asks over editing a lead in place: a revision to a
-- record the operator has already actioned is worse than a second record.
--
-- Index, not constraint: the lookup (`listInquiredParcelIds`, and the operator
-- reading a parcel's asks) is still by (parcelId, inquirerTenantId), so the
-- access path is kept while the uniqueness goes.
DROP INDEX IF EXISTS "InsuranceLead_parcelId_inquirerTenantId_key";
CREATE INDEX IF NOT EXISTS "InsuranceLead_parcelId_inquirerTenantId_idx"
    ON "InsuranceLead" ("parcelId", "inquirerTenantId");
