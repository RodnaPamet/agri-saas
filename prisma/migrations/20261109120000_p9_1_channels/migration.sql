-- ═══════════════════════════════════════════════════════════════════
--  P9.1 (#2935) — Channel, ChannelMembership, ChannelPost, reactions,
--  mentions. SCHEMA ONLY: no route, usecase, UI or flag.
-- ═══════════════════════════════════════════════════════════════════
--
--  Every policy below reads `app.user_id`, which ONLY `runInUserContext`
--  sets. NOT `app.actor_user_id`, which `runInTenantContext` sets alongside
--  a tenant. #1664 is what picking the wrong one costs: the arm matches
--  nothing, the read returns zero rows, and NOTHING ERRORS.
--
--  ── THE RECURSION RULE SHAPES THIS WHOLE FILE ──
--
--  A policy on a table may not query that table. P8.1 proved it the
--  expensive way: a WITH CHECK on `DirectMessage` reading `DirectMessage`
--  gave `ERROR: infinite recursion detected in policy for relation` and
--  refused EVERY insert.
--
--  "You may read the members if you are a member" is exactly that shape, so
--  `channel_membership_select` admits the caller's OWN ROW ONLY — the same
--  narrowness as `conversation_participant_select`, for the same reason.
--  `Channel.memberCount` is denormalised because of it.
--
--  Posts, reactions and mentions MAY query `ChannelMembership`: a different
--  table from the one being guarded, so no recursion arises.
--
--  ── A CHANNEL IS PUBLIC, unlike a conversation ──
--
--  `channel_select` admits any authenticated caller rather than members
--  only. P9.2 cannot suggest a channel nobody can read, and nobody would
--  join one they cannot look into first. The gate is on POSTING.
--
--  ── WHAT HAS NO `app_user` INSERT ARM, and why ──
--
--  `Channel` is seeded and administered; a caller able to insert one could
--  mint a channel impersonating a crop or an oblast. `ChannelMembership`'s
--  insert is privileged because joining maintains `Channel.memberCount` in
--  the same transaction, and a direct insert would leave the count wrong
--  with nothing detecting it. Both are `ContentReport`'s arrangement one
--  axis over (P5.2a): the write is privileged, the READ is policy-governed.
--
--  ── THE POSITIVE CONTROL IS NOT OPTIONAL ──
--
--  In P8.1 all three `REFUSES ...` cases passed while the rule enforced
--  nothing, because nothing could insert at all. Every refusal in
--  `tests/integration/p9-1-channels-rls.test.ts` is paired with the same
--  operation by somebody entitled to it.

-- ─────────────────────────────────────────────── enums

CREATE TYPE "ChannelKind" AS ENUM ('CROP', 'OBLAST', 'TOPIC');
CREATE TYPE "ChannelPostKind" AS ENUM ('POST', 'QUESTION', 'CARD');

-- ─────────────────────────────────────────────── tables

CREATE TABLE "Channel" (
    "id"              TEXT NOT NULL,
    "key"             TEXT NOT NULL,
    "nameBg"          TEXT NOT NULL,
    "nameEn"          TEXT NOT NULL,
    "descriptionBg"   TEXT,
    "descriptionEn"   TEXT,
    "kind"            "ChannelKind" NOT NULL,
    "memberCount"     INTEGER NOT NULL DEFAULT 0,
    "slowModeSeconds" INTEGER NOT NULL DEFAULT 0,
    "archivedAt"      TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Channel_key_key" ON "Channel"("key");
CREATE INDEX "Channel_kind_idx" ON "Channel"("kind");
CREATE INDEX "Channel_archivedAt_memberCount_idx" ON "Channel"("archivedAt", "memberCount");

CREATE TABLE "ChannelMembership" (
    "id"         TEXT NOT NULL,
    "channelId"  TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bannedAt"   TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3),
    "mutedAt"    TIMESTAMP(3),
    CONSTRAINT "ChannelMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelMembership_channelId_userId_key"
    ON "ChannelMembership"("channelId", "userId");
CREATE INDEX "ChannelMembership_userId_idx" ON "ChannelMembership"("userId");

CREATE TABLE "ChannelPost" (
    "id"                    TEXT NOT NULL,
    "channelId"             TEXT NOT NULL,
    "authorUserId"          TEXT NOT NULL,
    "body"                  TEXT NOT NULL,
    "kind"                  "ChannelPostKind" NOT NULL DEFAULT 'POST',
    "resolvedAt"            TIMESTAMP(3),
    "parentPostId"          TEXT,
    "removedByModerationAt" TIMESTAMP(3),
    "autoHiddenAt"          TIMESTAMP(3),
    "deletedAt"             TIMESTAMP(3),
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChannelPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChannelPost_channelId_createdAt_idx" ON "ChannelPost"("channelId", "createdAt");
CREATE INDEX "ChannelPost_parentPostId_idx" ON "ChannelPost"("parentPostId");
CREATE INDEX "ChannelPost_authorUserId_idx" ON "ChannelPost"("authorUserId");

CREATE TABLE "ChannelPostReaction" (
    "id"        TEXT NOT NULL,
    "postId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "emoji"     TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelPostReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelPostReaction_postId_userId_emoji_key"
    ON "ChannelPostReaction"("postId", "userId", "emoji");
CREATE INDEX "ChannelPostReaction_userId_idx" ON "ChannelPostReaction"("userId");

CREATE TABLE "ChannelPostMention" (
    "id"        TEXT NOT NULL,
    "postId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelPostMention_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelPostMention_postId_userId_key"
    ON "ChannelPostMention"("postId", "userId");
CREATE INDEX "ChannelPostMention_userId_idx" ON "ChannelPostMention"("userId");

-- ─────────────────────────────────────────────── foreign keys

ALTER TABLE "ChannelMembership" ADD CONSTRAINT "ChannelMembership_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPost" ADD CONSTRAINT "ChannelPost_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPost" ADD CONSTRAINT "ChannelPost_parentPostId_fkey"
    FOREIGN KEY ("parentPostId") REFERENCES "ChannelPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPostReaction" ADD CONSTRAINT "ChannelPostReaction_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "ChannelPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelPostMention" ADD CONSTRAINT "ChannelPostMention_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "ChannelPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────── RLS

ALTER TABLE "Channel"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Channel"             FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ChannelMembership"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelMembership"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ChannelPost"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelPost"         FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ChannelPostReaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelPostReaction" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ChannelPostMention"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelPostMention"  FORCE  ROW LEVEL SECURITY;

-- Channel: readable by ANY authenticated caller, which is the difference from
-- a conversation. P9.2 cannot suggest a channel nobody can read. No `app_user`
-- INSERT/UPDATE arm: channels are seeded and administered, and a caller able to
-- insert one could mint a channel impersonating a crop or an oblast.
CREATE POLICY channel_select ON "Channel"
    FOR SELECT
    USING (current_setting('app.user_id', true) IS NOT NULL
           AND current_setting('app.user_id', true) <> '');

CREATE POLICY superuser_bypass ON "Channel"
    USING (current_setting('role') != 'app_user');

-- ChannelMembership: the caller's OWN row only.
--
-- THIS NARROWNESS IS WHAT KEEPS THE POLICY LEGAL. A policy admitting "every
-- member of a channel I am in" must ask this same table whether I am in it,
-- which Postgres refuses outright. `Channel.memberCount` is denormalised
-- because of this, and a member list — if P9.5 ever needs one — has to come
-- from a privileged read, not from widening this.
CREATE POLICY channel_membership_select ON "ChannelMembership"
    FOR SELECT
    USING ("userId" = current_setting('app.user_id', true)::text);

-- The read cursor, the mute and LEAVING are the caller's own acts on their own
-- row. WITH CHECK repeats the USING clause so an UPDATE cannot reassign the row
-- to somebody else -- the `UserSession` lesson, where a single asymmetric
-- policy let a permissive sibling claim a row.
--
-- Note what this deliberately does NOT allow: clearing `bannedAt`. The column
-- is writable here, so the usecase must never route an unban through the user
-- context. A tighter arm would need a WITH CHECK comparing OLD and NEW, which
-- Postgres does not offer in a policy -- so this is enforced by the write path
-- being privileged, and `tests/integration/p9-1-channels-rls.test.ts` pins that
-- a banned member cannot post, which is the property that matters.
CREATE POLICY channel_membership_update ON "ChannelMembership"
    FOR UPDATE
    USING ("userId" = current_setting('app.user_id', true)::text)
    WITH CHECK ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY channel_membership_delete ON "ChannelMembership"
    FOR DELETE
    USING ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "ChannelMembership"
    USING (current_setting('role') != 'app_user');

-- ChannelPost: readable by any authenticated caller, because the channel is.
-- A non-member may READ and may not POST, which is the whole access model.
CREATE POLICY channel_post_select ON "ChannelPost"
    FOR SELECT
    USING (current_setting('app.user_id', true) IS NOT NULL
           AND current_setting('app.user_id', true) <> '');

-- The access rule P9.10 hardens, in SQL rather than only in a usecase -- the
-- usecase is the layer a refactor removes.
--
-- Three conditions, and each answers one of P9.10's three cases:
--   * the author is the session       -> a FORGED AUTHOR cannot post;
--   * a membership row exists         -> a NON-MEMBER cannot post;
--   * that row has `bannedAt` NULL    -> a BANNED MEMBER cannot post.
--
-- It queries `ChannelMembership`, which is a DIFFERENT table from the one being
-- guarded, so the recursion rule is satisfied. Slow mode and the mention cap
-- are NOT here: both need a comparison against other rows of this same table,
-- which is the shape that recurses. They live in the usecase, and P9.3 owns
-- them.
CREATE POLICY channel_post_insert ON "ChannelPost"
    FOR INSERT
    WITH CHECK (
        "authorUserId" = current_setting('app.user_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "ChannelMembership" m
            WHERE m."channelId" = "ChannelPost"."channelId"
              AND m."userId" = current_setting('app.user_id', true)::text
              AND m."bannedAt" IS NULL
        )
    );

-- The author's own edit and retraction. WITH CHECK pins the author so an UPDATE
-- cannot reassign the post to somebody else.
--
-- A moderator's removal and the auto-hide are NOT reachable here: both run
-- privileged, which is why `removedByModerationAt` and `autoHiddenAt` being
-- writable by this arm is acceptable only because the usecase never routes them
-- through a user context. P9.3 owns that, and its test is where it is pinned.
CREATE POLICY channel_post_update ON "ChannelPost"
    FOR UPDATE
    USING ("authorUserId" = current_setting('app.user_id', true)::text)
    WITH CHECK ("authorUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "ChannelPost"
    USING (current_setting('role') != 'app_user');

-- Reactions: SPLIT per command, for `ExchangeBlock`'s and `MessageReaction`'s
-- reason -- a reader must be able to SEE a reaction they did not write without
-- being able to DELETE it, and one USING clause would govern both.
CREATE POLICY channel_post_reaction_select ON "ChannelPostReaction"
    FOR SELECT
    USING (current_setting('app.user_id', true) IS NOT NULL
           AND current_setting('app.user_id', true) <> '');

CREATE POLICY channel_post_reaction_insert ON "ChannelPostReaction"
    FOR INSERT
    WITH CHECK (
        "userId" = current_setting('app.user_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "ChannelMembership" m
            JOIN "ChannelPost" p ON p."channelId" = m."channelId"
            WHERE p."id" = "ChannelPostReaction"."postId"
              AND m."userId" = current_setting('app.user_id', true)::text
              AND m."bannedAt" IS NULL
        )
    );

CREATE POLICY channel_post_reaction_delete ON "ChannelPostReaction"
    FOR DELETE
    USING ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "ChannelPostReaction"
    USING (current_setting('role') != 'app_user');

-- Mentions: readable, and written ONLY by the privileged write path.
--
-- No `app_user` INSERT arm, deliberately. A mention is a PUSH TRIGGER (P9.3
-- pushes for mentions and replies and nothing else), so a caller able to insert
-- one directly could push to any person on the platform without posting
-- anything they would read. The author's mentions are written in the same
-- privileged transaction as the post, where the five-mention cap is counted.
CREATE POLICY channel_post_mention_select ON "ChannelPostMention"
    FOR SELECT
    USING (current_setting('app.user_id', true) IS NOT NULL
           AND current_setting('app.user_id', true) <> '');

CREATE POLICY superuser_bypass ON "ChannelPostMention"
    USING (current_setting('role') != 'app_user');
