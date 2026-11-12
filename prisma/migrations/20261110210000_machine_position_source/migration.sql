-- #2948 — WHERE a machine position came from. Owner ruling 2026-11-10:
-- "build for the modern fleet first", so a manufacturer's telematics API is
-- the first source and the Codec 8 listener (#2973) the second. A row has to
-- say which, because provenance is the one thing that cannot be recovered
-- from the coordinates afterwards.
--
-- PURELY ADDITIVE: one enum, one column, one index. No DROP, no RENAME, no
-- rewrite of persisted data, so `destructive-migration-has-inverse` requires
-- no `.down.sql` — the previous image does not select this column and is
-- unaffected by its existence.

CREATE TYPE "MachinePositionSource" AS ENUM ('TRACKER', 'TELEMATICS');

-- ADD WITH A DEFAULT, THEN DROP THE DEFAULT. Two statements, and the pair is
-- the point.
--
-- Prisma's own diff emits `ADD COLUMN ... NOT NULL` with no default, which
-- fails outright on any table that already has rows. Adding it with a default
-- backfills existing rows as TRACKER — the only writer that has ever existed,
-- so that is their true provenance rather than a convenient guess.
--
-- Dropping the default afterwards is what makes the column carry a safety
-- property. With a default left in place, a telematics writer that forgets the
-- field silently MISLABELS location data as having come from an unauthenticated
-- Codec 8 socket; without one, it fails. `a-default-cannot-carry-a-safety-
-- property`: the schema declares no default, so the Prisma client requires the
-- field, and these two lines are how an additive migration gets there.
ALTER TABLE "MachinePosition"
    ADD COLUMN "source" "MachinePositionSource" NOT NULL DEFAULT 'TRACKER';
ALTER TABLE "MachinePosition"
    ALTER COLUMN "source" DROP DEFAULT;

-- "which machines have a telematics position today" without a sequential scan.
CREATE INDEX "MachinePosition_tenantId_source_idx"
    ON "MachinePosition"("tenantId", "source");
