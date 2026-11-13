-- P9.6 — channel voice notes and photos (#2940).
--
-- ============================================================================
-- WHY THIS SHIPS WITH ITS WRITER, UNLIKE P9.1
-- ============================================================================
--
-- P9's rule ships tables one release before the code that writes them, and
-- P9.1 did. This is not that: these are ADDITIVE NULLABLE COLUMNS on an
-- existing table plus one widening. P8.6 already made that reading explicitly
-- — "the rule exists so a NEW TABLE precedes its writer and a rollback stays
-- safe, and an additive nullable column on an existing table carries neither
-- risk" — and it is the reading that unblocks agrent-ios #2943, which is
-- waiting on this server half rather than on a schema.
--
-- ============================================================================
-- `body` BECOMES NULLABLE
-- ============================================================================
--
-- A voice note alone is a complete post, and so is a photograph. That is the
-- DM ruling (owner, 2026-11-07) one domain over, and the argument transfers
-- without weakening: requiring a caption to record two sentences about a pest
-- is friction nobody would defend out loud.
--
-- Keeping NOT NULL and storing '' was rejected for P8.6's reason: a NOT NULL
-- column that permits the empty string says nothing, and it leaves two
-- spellings of "no text" for every reader to handle.
--
-- Unlike `DirectMessage.body`, `ChannelPost.body` is PLAINTEXT — it is in
-- `DELIBERATELY_PLAINTEXT` keyed `ChannelPost.body`, because P9.7 requires
-- posts searchable and an encrypted column cannot be searched without a second
-- plaintext copy that would become the real store with nothing guarding it. So
-- the encryption-middleware null check that made P8.6's widening safe is not
-- even in play here.
--
-- What IS in play: `toPostView` already collapses a removed post to an empty
-- body, and `ChannelPostView.body` is read by the feed, the thread read and
-- the phone. A null reaching those is new, which is why the code stage maps
-- null to '' at the view boundary rather than letting it out.

ALTER TABLE "ChannelPost" ALTER COLUMN "body" DROP NOT NULL;

-- ============================================================================
-- ONE attachment per post, and the KIND is the mime
-- ============================================================================
--
-- Columns, not a `ChannelPostAttachment` link model, for the DM reason:
-- several photographs are several posts, which keeps the feed one card per
-- row. And ONE slot rather than a photo slot plus a voice slot, because a post
-- is either a recording or a picture — a schema that permits both would need a
-- rule about which renders first, and there is no product question asking for
-- it.
--
-- `FileRecord` cannot be reused, for P8.6's reason verbatim: its `tenantId` is
-- NOT NULL and a channel has no tenant. Inventing one — the author's current
-- farm — would file a person-scoped recording as a farm record and then hide
-- it from members in other tenants, because `FileRecord` is RLS-scoped by
-- tenant. So this is the RECORD-LESS upload class: `scanOrRefuse` BEFORE the
-- write, because there is no download gate to defer to, and egress authorised
-- by MEMBERSHIP.
ALTER TABLE "ChannelPost" ADD COLUMN "attachmentKey" TEXT;
ALTER TABLE "ChannelPost" ADD COLUMN "attachmentMime" TEXT;
ALTER TABLE "ChannelPost" ADD COLUMN "attachmentBytes" INTEGER;
ALTER TABLE "ChannelPost" ADD COLUMN "attachmentSha256" TEXT;

-- The DECLARED duration, in milliseconds, for audio only.
--
-- It is METADATA, not a control, and the distinction is the whole of #2940's
-- «max 2:00» requirement. The server sees bytes, not seconds: the ENFORCEABLE
-- cap is the byte ceiling in `channel-media.ts`, and this column exists so the
-- UI can show a length and draw a scrubber without downloading the file.
--
-- It is validated (0 < d <= 120000) and NOT trusted as evidence. A caller can
-- declare 1 ms for a two-minute recording; what they cannot do is exceed the
-- byte ceiling, which is why the ceiling is the cap. Enforcing seconds exactly
-- would mean decoding the container server-side, which this does not do — and
-- the honest statement of the consequence is in the usecase rather than left
-- for somebody to discover.
ALTER TABLE "ChannelPost" ADD COLUMN "attachmentDurationMs" INTEGER;

-- A post must SAY something. The usecase enforces "text OR an attachment";
-- this is the same invariant in the one place that survives a bug in it.
--
-- THREE removal columns appear in this arm, not one, and that is deliberate:
-- `deletedAt` is the author's retraction, `removedByModerationAt` a human
-- decision, `autoHiddenAt` P9.3d's threshold. Each must be able to leave a
-- post with no body AND no attachment, because the code stage clears the key
-- so a removed post stops serving its bytes. Omitting any one of them would
-- make that clearing fail at the database rather than the bytes stopping —
-- which is the failure P8.6's `deletedAt` arm was written to prevent, times
-- three.
ALTER TABLE "ChannelPost"
    ADD CONSTRAINT "channel_post_says_something" CHECK (
        "deletedAt" IS NOT NULL
        OR "removedByModerationAt" IS NOT NULL
        OR "autoHiddenAt" IS NOT NULL
        OR "body" IS NOT NULL
        OR "attachmentKey" IS NOT NULL
    );

-- The four attachment columns are ALL-OR-NOTHING. A key with no mime cannot
-- be served (the egress route sets the content type from it), and a mime with
-- no key names nothing. Half a row is the state no reader has a branch for.
ALTER TABLE "ChannelPost"
    ADD CONSTRAINT "channel_post_attachment_complete" CHECK (
        ("attachmentKey" IS NULL
            AND "attachmentMime" IS NULL
            AND "attachmentBytes" IS NULL
            AND "attachmentSha256" IS NULL)
        OR ("attachmentKey" IS NOT NULL
            AND "attachmentMime" IS NOT NULL
            AND "attachmentBytes" IS NOT NULL
            AND "attachmentSha256" IS NOT NULL)
    );

-- A duration without audio is meaningless, and audio without one leaves the
-- UI drawing a scrubber it cannot size. Keyed on the MIME prefix rather than
-- on a kind column, because the mime is what the egress route serves and a
-- second source of truth about "is this audio" is how the two come to
-- disagree.
ALTER TABLE "ChannelPost"
    ADD CONSTRAINT "channel_post_duration_is_audio_only" CHECK (
        ("attachmentDurationMs" IS NULL AND ("attachmentMime" IS NULL OR "attachmentMime" NOT LIKE 'audio/%'))
        OR ("attachmentDurationMs" IS NOT NULL AND "attachmentMime" LIKE 'audio/%')
    );

-- Serving an attachment resolves it by KEY, from a route that has already
-- authorised the caller by membership. Partial, because the overwhelming
-- majority of posts carry nothing.
CREATE INDEX "ChannelPost_attachmentKey_idx"
    ON "ChannelPost" ("attachmentKey")
    WHERE "attachmentKey" IS NOT NULL;

-- ============================================================================
-- NO NEW RLS POLICIES, AND WHAT THAT MEANS HERE IS STRONGER THAN FOR A DM
-- ============================================================================
--
-- Postgres RLS is ROW-level, so these columns are governed by the arms P9.1
-- already wrote. For a DM that means "readable by both participants". For a
-- channel post it means readable by ANY AUTHENTICATED CALLER, because
-- `channel_post_select` is deliberately public — P9.1's whole argument is that
-- nobody joins a channel they cannot look into first.
--
-- So the KEY is world-readable to authenticated callers, and that is acceptable
-- for the reason `attachmentKey`'s audit-redaction entry gives: it authenticates
-- nothing. The BYTES are not — the egress route requires membership, which is
-- a deliberate narrowing against the row's own visibility, and the reason is
-- the voice note rather than the photograph: a recording carries the speaker's
-- VOICE, which is a different class of personal data from their words, and
-- membership is the narrowest audience that still lets the feature work.
--
-- The consequence for the client half, written here because it is invisible
-- from the schema: a non-member reading a channel sees a post whose text is
-- there and whose media is not, so the UI must not render a broken player or a
-- placeholder image for them. agrent-ios #2943 owns that.
