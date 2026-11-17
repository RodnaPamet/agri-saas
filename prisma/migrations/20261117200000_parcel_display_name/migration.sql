-- agri-saas#3169: the farmer's own nickname for a parcel, for the app and the
-- assistant. Additive and nullable: no reader changes until it is set, and the
-- ДНЕВНИК never prints it.
ALTER TABLE "Parcel" ADD COLUMN "displayName" TEXT;
