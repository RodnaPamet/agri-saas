-- P8.6 — direct-message link cards (#2800).
--
-- ============================================================================
-- WHY THESE COLUMNS ARRIVE WITH THEIR WRITER, UNLIKE THE PHOTO ONES
-- ============================================================================
--
-- P8's rule ships tables one release before the code that writes them, and the
-- photo columns followed it. These do not, deliberately, and a GUARD is the
-- reason.
--
-- `linkTitle` and `linkDescription` must be declared in `ENCRYPTED_FIELDS`:
-- what somebody chose to SHARE in a private conversation is as revealing as
-- what they typed about it. Declaring a field there puts it in
-- `sanitize-rich-text-coverage`'s population, and that guard requires the
-- field to be sanitised BY NAME at its write path — `RICH_TEXT_COVERAGE`
-- already points `DirectMessage` at `direct-messages.ts`, which P8.2 made a
-- live writer. A schema-only stage has no write path to sanitise in, and
-- `SEAM_COVERED` verifies a seam that exists rather than promising one.
--
-- The alternative — ship the columns and leave them OUT of the manifest until
-- the code stage — is worse in the direction that matters: third-party text
-- would reach a column nothing had decided to encrypt, and the only thing
-- holding the obligation would be a sentence in a migration nobody re-reads.
--
-- So the columns, the manifest entry and the `sanitizePlainText` call are one
-- diff. That is a weaker reading of schema-a-release-ahead, and the rule's
-- purpose survives it: the rule exists so a NEW TABLE precedes its writer and
-- a rollback stays safe, and an additive nullable column on an existing table
-- carries neither risk — the previous image simply never reads them.

ALTER TABLE "DirectMessage" ADD COLUMN "linkUrl" TEXT;

-- ENCRYPTED under the global KEK, like `body`. Both are also UNTRUSTED REMOTE
-- TEXT, so the usecase sanitises them — encryption is not sanitisation (D.2),
-- and declaring a field encrypted says nothing about the renderer that
-- decrypts it.
ALTER TABLE "DirectMessage" ADD COLUMN "linkTitle" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "linkDescription" TEXT;

-- NO `linkImageKey` IN THIS STAGE, and the reason is the paragraph above.
--
-- The earlier draft of this migration added one, described as "stored like a
-- photograph", with nothing that writes it: `fetchLinkCard` reads two meta
-- tags and never fetches an image. A column whose safety argument has no
-- writer to check it against is the thing this file's own header argues
-- against — it would need a `conversation-columns-are-counterparty-safe` note
-- about what the other party can read from a column that holds nothing.
--
-- Storing the card's image is also not a column: it is a DECODE of bytes a
-- hostile server chose, so it needs `scanOrRefuse` BEFORE `stripImageMetadata`
-- (the decoder is the exposure, not what the scanner sees), a key, a storage
-- write and an egress route gated by participation — the whole record-less
-- upload shape P8.6's photo half built. That is #2855.
--
-- `20261107150000_p8_6_dm_media` names `linkImageKey` in its own forward plan.
-- That sentence is SUPERSEDED by this paragraph and is deliberately not
-- edited: an applied migration's checksum is recorded in `_prisma_migrations`,
-- so changing even a comment makes `prisma migrate deploy` refuse the whole
-- history with "migration modified after applied".

-- When the fetch happened. A card is a SNAPSHOT of a third-party page at a
-- moment; without this a reader cannot tell a fresh card from a stale one, and
-- re-fetching later would silently rewrite what two people discussed.
ALTER TABLE "DirectMessage" ADD COLUMN "linkFetchedAt" TIMESTAMP(3);

-- The "says something" CHECK gains `linkUrl`.
--
-- Dropped and recreated rather than altered, because Postgres has no ALTER
-- CONSTRAINT for a CHECK expression. The `deletedAt` arm stays first and stays
-- load-bearing: retracting clears the attachment AND link columns, and a
-- retracted link-only message would otherwise have nothing left, so the
-- database would refuse the clearing and fail the DELETION rather than
-- stopping the card.
ALTER TABLE "DirectMessage" DROP CONSTRAINT "direct_message_says_something";
ALTER TABLE "DirectMessage"
    ADD CONSTRAINT "direct_message_says_something" CHECK (
        "deletedAt" IS NOT NULL
        OR "body" IS NOT NULL
        OR "attachmentKey" IS NOT NULL
        OR "linkUrl" IS NOT NULL
    );

-- No new RLS policies: these are columns on a table that already has
-- `FORCE ROW LEVEL SECURITY` and its P8.1 policy set, and Postgres RLS is
-- ROW-level, so every new column is governed by the arms already there. That
-- is also the warning, which is why
-- `conversation-columns-are-counterparty-safe` requires a written note per
-- column: the other party reads every column of the row.
