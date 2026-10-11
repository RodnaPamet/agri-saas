-- #1619 — the moderation decisions enter the hash-chained platform trail.
--
-- Two enum values. `PlatformAuditAction` is a Postgres enum, so adding one is a
-- migration; `ADD VALUE IF NOT EXISTS` is not transactional on older Postgres,
-- which is why these are the only statements in the file and re-running is
-- safe.
--
-- They join the `moderation` SCOPE that P5.9 opened for suspensions, rather
-- than starting a third chain. `scope` is the chain key, so an operator
-- reading "the moderation history" gets the decision (this migration) and its
-- consequence (a suspension) in one verifiable sequence. Two scopes would make
-- that one history into two, each verifying perfectly and neither complete.
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'MODERATION_ACTION_RECORDED';
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'MODERATION_STATEMENT_QUEUED';
