-- ParcelIndexReading — one parcel's Sentinel-2 index means per ACQUISITION day.
--
-- #2837. Owner, relayed 2026-11-07: "can we store past data so the app and the
-- assistant provide info based on a time period, like the past 14 days". The
-- existing 6h Redis entry behind `/analysis` keeps only today's answer, so
-- every reading older than the current entry was gone; a period question needs
-- a record rather than a cache.
--
-- Nothing here is encrypted, and that is deliberate: a field mean is derived
-- agronomic data about the farm's own land. `ENCRYPTED_FIELDS` is also
-- string-only.
CREATE TABLE "ParcelIndexReading" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parcelId" TEXT NOT NULL,
    -- The acquisition DAY, UTC. A pass is identified by its day throughout
    -- this feature; `date` rather than `timestamp` so a client's timezone
    -- cannot shift which day a reading belongs to.
    "acquiredOn" DATE NOT NULL,
    -- NULL = the pass existed and this parcel was fully cloud-masked for it.
    -- A different fact from no row at all: conflating them would make the
    -- backfill re-ask Earth Engine about every cloudy day for ever.
    "ndvi" DOUBLE PRECISION,
    "ndmi" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParcelIndexReading_pkey" PRIMARY KEY ("id")
);

-- One row per parcel per acquisition day. This is what makes the write an
-- idempotent upsert: re-running an analysis for a stored day replaces that
-- day's numbers instead of appending a second reading the chart would draw
-- twice.
--
-- Its index is also the only read shape — `tenantId = ? AND parcelId = ? AND
-- "acquiredOn" >= ? ORDER BY "acquiredOn"` — equality, equality, then the
-- range and the sort key, in query order. A separate index on the same three
-- columns would be the same B-tree twice, which is why no `@@index` is
-- declared and the model is triaged in
-- LIST_MODELS_TENANT_INDEX_SUFFICIENT instead. Layer A is satisfied by the
-- tenantId-leading construct; Layer B accepts `parcelId` as the second column
-- of a tenantId-leading composite on a tenant model.
CREATE UNIQUE INDEX "ParcelIndexReading_tenantId_parcelId_acquiredOn_key"
    ON "ParcelIndexReading"("tenantId", "parcelId", "acquiredOn");

-- Composite FK carrying tenantId, matching ParcelComment / ParcelCropSeason:
-- a row cannot point at another farm's parcel even if the id were guessed.
ALTER TABLE "ParcelIndexReading" ADD CONSTRAINT "ParcelIndexReading_parcelId_tenantId_fkey"
    FOREIGN KEY ("parcelId", "tenantId") REFERENCES "Parcel"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ParcelIndexReading" ADD CONSTRAINT "ParcelIndexReading_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
--  The coverage watermark, on Parcel.
--
--  The window of acquisition dates this parcel has been ASKED about — not the
--  window it has readings FOR. A date with no reading row means either "no
--  cloud-free pass" or "never asked", and the readings table cannot tell them
--  apart; without this, the history read would call Earth Engine on every
--  request for every cloudy day, for ever, and storing the readings would
--  save nothing.
--
--  Both NULL = never asked. Additive and nullable, so the previous image
--  queries this table fine and no inverse script is required.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "Parcel" ADD COLUMN "indexReadingsFrom" DATE;
ALTER TABLE "Parcel" ADD COLUMN "indexReadingsThrough" DATE;

-- Which scene-selection algorithm that window was searched under
-- (`SCENE_SELECTION_VERSION`). The watermark is only believable alongside the
-- rules that produced it: a later change admitting MORE passes — a looser
-- tile-level cloud threshold, say — would otherwise leave every watermark
-- claiming dates were searched under rules that REJECTED the pass now wanted,
-- and nothing would go back for them. A mismatch reads as "never asked", so a
-- bump re-searches every parcel with no migration step to forget.
ALTER TABLE "Parcel" ADD COLUMN "indexReadingsAlgo" INTEGER;

-- ═══════════════════════════════════════════════════════════════════
--  RLS. `tenantId` is NON-null, so the split tenant_isolation (USING) +
--  tenant_isolation_insert (WITH CHECK) form applies — the ParcelComment /
--  TaskComment shape, not the single asymmetric policy UserSession needs for
--  its NULLABLE column.
--
--  FORCE, not merely ENABLE: without it the table owner bypasses its own
--  policies, and `rls-coverage` asserts both.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ParcelIndexReading']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation_insert ON %I FOR INSERT WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true)::text)', t);
    EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', t);
    EXECUTE format('CREATE POLICY superuser_bypass ON %I USING (current_setting(''role'') != ''app_user'')', t);
  END LOOP;
END
$$;
