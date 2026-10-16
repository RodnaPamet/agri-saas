-- P6.3 (#1812) — image hashes for the farm profile, one release ahead of the
-- pipeline that writes them.
--
-- ## Why hashes and not foreign keys
--
-- `PublicFarmProfile` is TENANTLESS. It is the public read model, keyed by
-- handle, with no `tenantId` column and no RLS policy — that is what lets an
-- anonymous request read it. So it cannot hold a foreign key into
-- `FileRecord`, which is tenant-scoped: the FK would be a reference the
-- reader has no tenant context to resolve.
--
-- A content hash is self-contained. It survives the projection boundary the
-- way `crops TEXT[]` already does, and it makes `/api/public/media/[hash]`
-- immutable for free: one sha256 names exactly one byte sequence, so the
-- route can be cached forever with no invalidation story.
--
-- ## The projection is the authority, not FileRecord
--
-- A hash is unguessable but PERMANENT, so "serve any FileRecord with this
-- hash" would keep an image reachable after a farm unpublished it — the
-- capability could never be revoked. The media route will instead require
-- that some `PublicFarmProfile` row reference the hash, which ties the bytes'
-- reachability to the same row that publishes everything else: unpublishing
-- deletes the projection, and the image stops resolving in the same step.
--
-- That is why the projection gets its own copies of these columns rather than
-- the route joining back to `FarmBrand`.
--
-- ## Nothing writes these yet
--
-- No column here is backfilled and every one is nullable or an empty array.
-- The sharp pipeline, the media route and the upload surface are the NEXT PR;
-- this one exists so the columns are present in production before any code
-- reads them, which is the phase rule the rest of P6 has followed.

-- Both array columns are a bare `TEXT[]`: nullable, no SQL default. That is
-- Prisma's own convention for a scalar list and it is what `crops` on this
-- same table already is — the client reads SQL NULL as `[]`, so a default
-- would be redundant. It is also not merely redundant: declaring
-- `NOT NULL DEFAULT ARRAY[]::TEXT[]` here puts the database ahead of
-- `schema.prisma`, and the next person to run `migrate dev` gets a migration
-- "fixing" a divergence they did not cause.

-- The editable source of truth, tenant-scoped.
ALTER TABLE "FarmBrand" ADD COLUMN "logoMediaHash"    TEXT;
ALTER TABLE "FarmBrand" ADD COLUMN "photoMediaHashes" TEXT[];

-- The public projection. Same shape, deliberately duplicated rather than
-- joined: see above.
ALTER TABLE "PublicFarmProfile" ADD COLUMN "logoMediaHash"    TEXT;
ALTER TABLE "PublicFarmProfile" ADD COLUMN "photoMediaHashes" TEXT[];

-- sha256 of the stored bytes, hex. Written only for processed public images.
--
-- Deliberately NOT unique: two tenants can upload the same photograph, and a
-- cross-tenant unique constraint would make the second upload fail — or worse,
-- if deduplicated, make one farm's bytes reachable through another farm's
-- profile.
ALTER TABLE "FileRecord" ADD COLUMN "contentSha256" TEXT;

-- The media route's only query is by this column alone — it has no tenant to
-- scope by. Every other index on this table leads with `tenantId`.
CREATE INDEX "FileRecord_contentSha256_idx" ON "FileRecord"("contentSha256");
