-- Reverse of 20261002190000_p1_7_insurance_lead_rls.
--
-- Dropping the policies BEFORE disabling RLS, in that order: a table with RLS
-- enabled and no policy denies everything to `app_user`, so the reverse order
-- would leave a window where every insurance read returns zero rows rather
-- than restoring the prior behaviour.
DROP POLICY IF EXISTS insurance_lead_inquirer_isolation ON "InsuranceLead";
DROP POLICY IF EXISTS superuser_bypass                  ON "InsuranceLead";

ALTER TABLE "InsuranceLead" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "InsuranceLead" DISABLE  ROW LEVEL SECURITY;
