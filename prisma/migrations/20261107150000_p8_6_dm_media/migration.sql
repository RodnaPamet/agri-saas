-- P8.6 — direct-message photos and link cards (#2800). SCHEMA ONLY.
--
-- P8's rule ships tables one release before the code that writes them, so no
-- route, usecase, UI or flag lands with this. P8.1 and P5.1 did the same.
--
-- ============================================================================
-- `body` BECOMES NULLABLE — owner ruling 2026-11-07
-- ============================================================================
--
-- "May a photo be sent with no text?" — yes. A photo alone is a complete
-- message in every chat application a Bulgarian farmer already uses, and
-- requiring a caption to photograph a pest is the kind of friction nobody
-- would defend out loud.
--
-- The alternative that needs no migration — keep NOT NULL and store '' — was
-- rejected: a NOT NULL column that permits the empty string says nothing, and
-- it leaves TWO spellings of "no text" ('' and NULL) for every reader to
-- handle. Deciding it now rather than at the code stage is deliberate: a
-- second migration over an encrypted column, after rows exist, is the
-- expensive version of this change.
--
-- Three things make the widening safe, each checked rather than assumed:
--
--   * The ENCRYPTION MIDDLEWARE skips null. `src/lib/db/encryption-middleware.ts`
--     returns early on `value === null || value === undefined` on the encrypt
--     path AND on both decrypt paths, so a null in a declared field is passed
--     through rather than fed to the cipher.
--   * The READ PATH already types it nullable. `DirectMessageView.body` is
--     `string | null` and `MessageBubbleProps.body` is `string | null`,
--     because a DELETED message is presented as null. No client change.
--   * The PREVIOUS IMAGE cannot create a null-body row — its
--     `SendDirectMessageSchema` requires `body` min(1) — and renders one as an
--     empty bubble rather than crashing. So an image rollback DEGRADES a
--     photo-only message; it does not break the screen. That is why there is
--     no inverse script here: `destructive-migration-has-inverse` derives its
--     population from DROP TABLE / DROP COLUMN / DROP TYPE / RENAME, and
--     re-asserting NOT NULL would fail against exactly the rows this enables.
--
-- ============================================================================
-- ONE photo per message — owner ruling 2026-11-07
-- ============================================================================
--
-- Columns on `DirectMessage`, not a `DirectMessageAttachment` link model.
-- Several photos are several messages, which is what WhatsApp and Telegram do
-- and what keeps the timeline one bubble per row.
--
-- `LogEntryFile` is the in-repo precedent for an attachment and it CANNOT be
-- reused here: it links to `FileRecord`, whose `tenantId` is NOT NULL, and a
-- direct message has no tenant. Inventing one — the sender's current farm —
-- would file a person-scoped photo as a farm record and then hide it from a
-- recipient in a different tenant, because `FileRecord` is RLS-scoped by
-- tenant. So a DM photo is the RECORD-LESS upload class: the bytes carry no
-- `FileRecord`, which means `scanOrRefuse` runs BEFORE the write (there is no
-- download gate to defer to) and the egress route authorises by
-- PARTICIPATION. The code stage owes both.
--
-- ============================================================================
-- WHAT THE CODE STAGE MUST NOT FORGET
-- ============================================================================
--
-- `deleteDirectMessage` currently sets `body = ''`, destroying the plaintext.
-- It must also CLEAR `attachmentKey` and remove the stored object. Left as they are, a deleted message keeps serving its photo to a
-- participation-checked route — and P5.3's rule is that a deleted message has
-- participation-checked route — and P5.3's rule is that a deleted message has
-- nothing to capture. The column is nullable precisely so clearing is
-- available.

ALTER TABLE "DirectMessage" ALTER COLUMN "body" DROP NOT NULL;

-- The photo. `attachmentKey` is an opaque storage key, deliberately NOT
-- encrypted: it is not content, and `FileRecord.pathKey` is plaintext for the
-- same reason. The digest is what lets a re-send dedupe without decrypting
-- anything.
ALTER TABLE "DirectMessage" ADD COLUMN "attachmentKey" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "attachmentMime" TEXT;
ALTER TABLE "DirectMessage" ADD COLUMN "attachmentBytes" INTEGER;
ALTER TABLE "DirectMessage" ADD COLUMN "attachmentSha256" TEXT;

-- ============================================================================
-- THE LINK-CARD COLUMNS ARE NOT HERE, AND A GUARD IS WHY
-- ============================================================================
--
-- They were, in the first draft: `linkUrl`, `linkTitle`, `linkDescription`,
-- `linkImageKey`, `linkFetchedAt`, with the two text columns declared in
-- `ENCRYPTED_FIELDS` because what somebody chose to SHARE privately is as
-- revealing as what they typed about it.
--
-- `sanitize-rich-text-coverage` refused that, correctly. Declaring a field
-- encrypted puts it in that guard's population, and the guard requires the
-- field to be sanitised BY NAME at its write path — `RICH_TEXT_COVERAGE`
-- already points `DirectMessage` at `direct-messages.ts`, which P8.2 made a
-- live writer. A schema-only stage cannot discharge that: there is no write
-- path to sanitise in. `SEAM_COVERED` is no help either, since it verifies a
-- seam that exists rather than promising one.
--
-- The alternative — ship the columns and leave them OUT of the manifest until
-- the code stage — is worse in the direction that matters: third-party text
-- would reach a column nothing had decided to encrypt, and the only thing
-- holding the obligation would be a sentence in a migration nobody re-reads.
--
-- So the link-card columns land WITH the code that writes them, where the
-- manifest entry and the `sanitizePlainText` call are one diff. That is a
-- weaker reading of P8's schema-a-release-ahead rule, and deliberately: the
-- rule exists so a NEW TABLE precedes its writer and a rollback stays safe,
-- and an additive nullable column on an existing table carries neither risk.
-- #2800 carries the obligation list.

-- A message must SAY something. The usecase will enforce "text OR a photo",
-- and this is the same invariant in the one place that survives a bug in it.
--
-- The `deletedAt` arm is load-bearing: `deleteDirectMessage` writes
-- `body = ''`, which is NOT NULL and so satisfies the constraint today — but
-- the code stage must also clear the attachment key on delete, and a deleted
-- photo-only message would then have nothing left. Without this arm that
-- clearing would be refused by the database, and the deletion would fail
-- rather than the photo stopping.
ALTER TABLE "DirectMessage"
    ADD CONSTRAINT "direct_message_says_something" CHECK (
        "deletedAt" IS NOT NULL
        OR "body" IS NOT NULL
        OR "attachmentKey" IS NOT NULL
    );

-- Serving a photo resolves it by KEY, from a route that has already
-- authorised the caller by participation. Partial, because the overwhelming
-- majority of messages carry no attachment.
CREATE INDEX "DirectMessage_attachmentKey_idx"
    ON "DirectMessage" ("attachmentKey")
    WHERE "attachmentKey" IS NOT NULL;

-- No new RLS policies. These are columns on a table that already has
-- `FORCE ROW LEVEL SECURITY` and its P8.1 policy set, and Postgres RLS is
-- ROW-level — so every new column is governed by the arms already there.
-- That is also the warning: anything added to this table is readable by both
-- participants, which is correct here and is the reason the reporter-safety
-- guard exists one table over.
