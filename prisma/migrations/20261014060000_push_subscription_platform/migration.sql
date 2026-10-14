-- #1764 — one table for both push transports, with per-platform integrity.
--
-- `PushSubscription` modelled a W3C PushSubscription and nothing else: an
-- https `endpoint` plus `p256dh`/`auth`, all NOT NULL. An APNs device token is
-- 64 hex characters, not a URL, and has no analogue for the two key columns —
-- so there was no way for the native client to register for push and no way
-- for the server to address a phone (agrent-ios#272).
--
-- ## One table, and the cost the issue expected is not paid
--
-- #1764 framed the choice as one table with a discriminator versus a second
-- table, the one-table cost being that `endpoint`/`p256dh`/`auth` go nullable
-- and "weaken the Web Push rows' own constraint".
--
-- CHECK constraints make nullability PER-PLATFORM instead of global, so a Web
-- Push row still cannot exist without its three fields and an iOS row cannot
-- exist without a token or carrying Web Push fields it has no meaning for.
-- One table keeps `[tenantId, userId]` as the single recipient lookup every
-- sender does — the thing worth preserving — and the constraints survive.
--
-- ## The existing unique index is UNTOUCHED, deliberately
--
-- An earlier draft dropped `PushSubscription_tenantId_userId_endpoint_key` and
-- replaced it with two partial unique indexes. That is unnecessary: Postgres
-- treats NULLs as DISTINCT in a unique index, so the existing index continues
-- to constrain Web Push rows exactly as before and simply ignores iOS rows,
-- whose `endpoint` is NULL. Leaving it alone makes this migration strictly
-- additive, which is why no `.down.sql` accompanies it
-- (`deploy/rollback/README.md`: a script is needed when a migration renames,
-- drops or narrows something the previous image still uses — widening a NOT
-- NULL is none of those, and the previous image always writes all three
-- columns anyway).
--
-- iOS identity needs its own index because the token, not an endpoint, is the
-- natural key. It is PARTIAL, so it costs nothing on the Web Push rows and
-- does not collide with them. Prisma cannot express a partial index, so this
-- one lives here and the client is unaware — the same arrangement as
-- `ContentReport`'s partial `[alertedAt, createdAt]`. A future
-- `prisma migrate diff` will want to "fix" the apparent absence; it must not.

-- Both transports, named for what they are. Defaulted so every existing row
-- is valid the instant the column exists, and so the previous image — which
-- knows nothing about this column — keeps writing rows that satisfy the
-- Web Push CHECK below.
CREATE TYPE "PushPlatform" AS ENUM ('WEB', 'IOS');

ALTER TABLE "PushSubscription"
    ADD COLUMN "platform" "PushPlatform" NOT NULL DEFAULT 'WEB',
    ADD COLUMN "deviceToken" TEXT;

ALTER TABLE "PushSubscription"
    ALTER COLUMN "endpoint" DROP NOT NULL,
    ALTER COLUMN "p256dh" DROP NOT NULL,
    ALTER COLUMN "auth" DROP NOT NULL;

-- A Web Push row is exactly what it always was.
ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_web_shape" CHECK (
        "platform" <> 'WEB'
        OR (
            "endpoint" IS NOT NULL
            AND "p256dh" IS NOT NULL
            AND "auth" IS NOT NULL
            AND "deviceToken" IS NULL
        )
    );

-- An iOS row carries a token and none of the Web Push fields. Stated as a
-- mutual exclusion rather than just "token not null": a row carrying both
-- would make the deliverer's per-row dispatch ambiguous, and ambiguity in a
-- fan-out is how a notification goes to the wrong transport silently.
ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_ios_shape" CHECK (
        "platform" <> 'IOS'
        OR (
            "deviceToken" IS NOT NULL
            AND "endpoint" IS NULL
            AND "p256dh" IS NULL
            AND "auth" IS NULL
        )
    );

-- One row per (tenant, user, device token). PARTIAL — see the header.
CREATE UNIQUE INDEX "PushSubscription_ios_identity"
    ON "PushSubscription" ("tenantId", "userId", "deviceToken")
    WHERE "platform" = 'IOS';

-- The per-recipient lookup every sender does, now that it has to split by
-- transport. The existing unique index already serves `[tenantId, userId]`
-- as a prefix, so this exists for the platform-filtered form the deliverer
-- will use rather than for the recipient resolution itself.
CREATE INDEX "PushSubscription_tenantId_userId_platform_idx"
    ON "PushSubscription" ("tenantId", "userId", "platform");
