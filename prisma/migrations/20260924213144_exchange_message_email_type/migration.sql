-- A nudge to the other party that a conversation has moved.
--
-- Additive enum value, in the separate-statement form every other additive
-- enum migration here uses (Postgres cannot add an enum value inside a
-- transaction block in older versions; Prisma runs each file in one).
ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'EXCHANGE_MESSAGE';
