-- P1.7 — InsuranceLead: row-level security on the cross-tenant axis.
--
-- `InsuranceLead` holds one farm's contact PII (message, plus the user and
-- tenant who asked) and keys on `inquirerTenantId`, a plain FK that is
-- deliberately NOT a `tenantId` RLS column. That is the same shape as
-- `PromotionLead` and `ExchangeInquiry`, and it has the same consequence: the
-- rls-coverage inventory keys off `tenantId`, so this table sat outside the
-- ratchet entirely while migration 20260323180000 granted `app_user` full DML
-- on every table in the schema.
--
-- ── this is a BACKSTOP, not a live leak ──
--
-- Stated precisely because the difference matters. Every one of the four call
-- sites in `src/app-layer/usecases/insurance.ts` already filters correctly:
-- three reads carry `inquirerTenantId: ctx.tenantId` and the create sets it.
-- So no tenant can read another's leads today. What is missing is the
-- DB-side backstop — one forgotten `where` in a future repository method
-- would read every farm's insurance enquiries, under `app_user`, with nothing
-- beneath it. `PromotionLead` was fixed for exactly this reason in
-- 20260721090000 and the guard's comment calls it "the failure mode the
-- ratchet exists to prevent".
--
-- The model's own docblock asserted "so the row is not tenant-scoped and
-- needs no RLS", and `insurance.ts:312` went further — it offered the ABSENCE
-- of RLS as the reason one farm's key cannot return another's lead. That had
-- the causality backwards: the safety came from the explicit `where`, and the
-- comment told the next reader the absence was fine. Both are corrected in
-- this change.
--
-- ── shape: a single policy ──
--
-- Not the split tenant_isolation / tenant_isolation_insert pair, for the same
-- reason as PromotionLead: `inquirerTenantId` is NOT NULL, so there is no
-- nullable-row case needing a permissive USING, and USING and WITH CHECK can
-- both be the strict own-tenant predicate. Named for the column it keys on so
-- it stays obvious this is a parallel axis rather than standard tenantId
-- isolation.

ALTER TABLE "InsuranceLead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceLead" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS insurance_lead_inquirer_isolation ON "InsuranceLead";
DROP POLICY IF EXISTS superuser_bypass                  ON "InsuranceLead";

CREATE POLICY insurance_lead_inquirer_isolation ON "InsuranceLead"
    USING      ("inquirerTenantId" = current_setting('app.tenant_id', true)::text)
    WITH CHECK ("inquirerTenantId" = current_setting('app.tenant_id', true)::text);

-- Privileged paths (seeds, migrations, any future platform-side lead digest)
-- run as a non-`app_user` role and bypass, exactly as every other table does.
CREATE POLICY superuser_bypass ON "InsuranceLead"
    USING (current_setting('role') != 'app_user');
