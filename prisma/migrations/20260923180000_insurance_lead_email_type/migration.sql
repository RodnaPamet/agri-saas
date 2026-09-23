-- A farmer's insurance-quote ask, mailed to the platform operator.
--
-- Additive enum value. Postgres cannot add an enum value inside a
-- transaction block in older versions; Prisma runs each migration file in one,
-- so this uses the separate-statement form that has been safe since PG 12 and
-- is what every other additive enum migration here does.
ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'INSURANCE_LEAD';
