-- Карантинен срок captured per operation line, as it applied on the day
-- (#1775). Additive and nullable: existing lines stay NULL and the register
-- keeps falling back to the product for them, which is the behaviour they
-- were written under.
--
-- No backfill, deliberately. Nothing records what a product's period WAS when
-- an old line was completed, so copying today's value would put a number in a
-- regulatory document that nobody captured.
ALTER TABLE "OperationParcel" ADD COLUMN "quarantinePeriodDays" INTEGER;
