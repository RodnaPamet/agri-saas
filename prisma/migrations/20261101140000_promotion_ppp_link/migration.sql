-- #2664 — mark a promotion as being for a plant protection product.
--
-- Additive and nullable, so the previous image keeps working: NULL means "not
-- a ПРЗ", which is what every existing row is. No inverse script needed under
-- `deploy/rollback/README.md`'s rule (nothing renamed, dropped or rewritten).
ALTER TABLE "Promotion" ADD COLUMN "pppRegistrationNo" TEXT;

-- Promotions are platform-wide and tenantless, so there is no tenant index to
-- add. The lookup this serves is by promotion id, already the primary key.
