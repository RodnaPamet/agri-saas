-- #2989 — the farm a channel post was made AS, recorded at write time.
--
-- Additive and nullable, so the previous image reads and writes ChannelPost
-- exactly as before and no down-migration is needed: nothing is renamed,
-- dropped or re-encoded, which is what `destructive-migration-has-inverse`
-- derives its population from.
--
-- No foreign key to "Tenant", matching "authorUserId" on the same table. This
-- table is tenantless, and a declared FK would make a farm undeletable while
-- any post still referenced it — a post is a person's, not a farm's.
--
-- No index. The read path resolves farm names by collecting the DISTINCT ids
-- from one page and issuing a single "Tenant" lookup keyed by primary key, so
-- nothing ever filters or joins on this column.

ALTER TABLE "ChannelPost"
    ADD COLUMN "authorTenantId" TEXT;
