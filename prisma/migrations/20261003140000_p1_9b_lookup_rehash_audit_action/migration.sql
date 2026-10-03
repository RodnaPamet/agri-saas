-- #1237 — one more `PlatformAuditAction`, for the lookup-hash rehash sweep.
--
-- The sweep is a platform-operator mutation of exactly the class P1.9 built
-- the chain for: it rewrites `emailHash` on every `User` row, and the operator
-- then DELETES a key on the strength of its verdict. An unaudited run of it
-- would leave no record of who swept, when, or what the verdict said at the
-- moment the key was retired.
--
-- It joins the `key-rotation` SCOPE rather than starting a `lookup-rehash` one.
-- Both are steps in retiring an old key, an operator reads them as one history,
-- and a second chain would verify cleanly while the history you meant to append
-- to looked untouched — the hazard `appendPlatformAuditEntry` already refuses
-- an unlisted scope to avoid.

-- `ADD VALUE IF NOT EXISTS` so a re-run is a no-op, matching the DO-block
-- idempotence of the migration that created the type. Postgres 12+ permits
-- this inside a transaction as long as the new value is not USED in the same
-- transaction, which nothing here does.
ALTER TYPE "PlatformAuditAction" ADD VALUE IF NOT EXISTS 'LOOKUP_HASH_REHASHED';
