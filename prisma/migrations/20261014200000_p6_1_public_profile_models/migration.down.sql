-- Rollback for 20261014200000_p6_1_public_profile_models.
--
-- DESTRUCTIVE: drops three tables and everything in them. Safe only
-- while nothing writes them, which is true for exactly one release —
-- this migration ships the tables and the writer comes later. After
-- the writer ships, rolling back costs every published profile.
--
-- Policies are dropped explicitly before the tables rather than relying
-- on the cascade, so a partial rollback cannot leave a policy behind
-- referring to a table that is gone.
DROP POLICY IF EXISTS superuser_bypass ON "FarmBrand";
DROP POLICY IF EXISTS tenant_isolation_insert ON "FarmBrand";
DROP POLICY IF EXISTS tenant_isolation ON "FarmBrand";

DROP TABLE IF EXISTS "PublicFarmProfile";
DROP TABLE IF EXISTS "PersonProfile";
DROP TABLE IF EXISTS "FarmBrand";
