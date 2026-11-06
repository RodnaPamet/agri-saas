-- P8.1 (#2795) — direct messages: four tables, person-scoped RLS.
--
-- SCHEMA ONLY. P8's standing rule is that tables ship one release before the
-- code that writes them (P5.1 / #1553 is the precedent), so nothing in this
-- migration is reachable from a route.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.user_id`, NOT `app.actor_user_id`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every policy below keys on `app.user_id`, the variable `runInUserContext`
-- sets. `runInTenantContext` sets `app.actor_user_id` and deliberately NOT
-- `app.user_id`.
--
-- Reading the wrong one does not raise. The unset variable yields NULL, the
-- arm matches nothing, and the caller sees zero rows -- which is exactly what
-- "you have no messages" looks like. #1664 is that failure in full: UserBlock's
-- SELECT policy keyed on `app.user_id` while enforcement ran under
-- `app.actor_user_id`, so `personBlockExists` returned false for every pair,
-- always, and no log said so. Measured with a positive control: the same row,
-- the same helper, 1 under a user context and 0 under a tenant context.
--
-- A direct conversation is between PEOPLE who may share no farm, so there is
-- no tenant to key on even in principle. That is why P8.2's routes go under
-- `/api/social/`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What each table admits, and why writes are mostly privileged
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Access is by PARTICIPATION. Opening a conversation writes the OTHER person's
-- `ConversationParticipant` row, which a caller must never be able to forge --
-- so there is no `app_user` INSERT on `Conversation` or
-- `ConversationParticipant` at all, and those writes run on the privileged
-- path with the usecase as the control. That is the P5.2a posture: "a reporter
-- who could insert directly could forge `reporterUserId`".
--
-- `DirectMessage` is the exception, and it is where the REQUEST rule lives.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Two refusal shapes, and only one of them raises
-- ─────────────────────────────────────────────────────────────────────────────
--
-- With no permissive policy for a command, the rows to change are selected by
-- a USING clause that is effectively false: the statement affects ZERO rows
-- and RETURNS NORMALLY. A `WITH CHECK` violation on INSERT raises 42501.
--
-- So every negative in `tests/integration/p8-1-direct-message-rls.test.ts`
-- asserts a row COUNT or an error CODE, never that a call returned -- and
-- every positive asserts a NON-ZERO count, because a silently unset session
-- variable also produces zero. A suite of only-negatives passes against a
-- connection bound to nothing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A BLOCK is NOT enforced here, and that is a limit rather than an omission
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `conversation_participant_select` admits the caller's OWN row only, because
-- a policy admitting "every participant of a conversation I am in" must ask
-- this same table whether I am in it, and Postgres refuses that with
-- `infinite recursion detected in policy for relation`.
--
-- The consequence: SQL here cannot name the counterparty, so a WITH CHECK
-- cannot ask whether the counterparty has blocked the sender. A clause that
-- tried would be VACUOUS -- the participant subquery returns only the caller,
-- so `blockerUserId` could only ever equal the caller, which is never a block
-- against them. A vacuously-true clause that reads as a control is worse than
-- no clause, so there is none.
--
-- Blocks are enforced in the usecase (P8.2) through the existing bidirectional
-- `personBlockExists`, and the silence is preserved by the 404: a blocked
-- caller cannot see the conversation to address it.

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('REQUEST', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'REQUEST',
    "initiatedByUserId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_initiatedByUserId_idx" ON "Conversation"("initiatedByUserId");

-- CreateIndex
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "DirectMessage_conversationId_createdAt_idx" ON "DirectMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DirectMessage_senderUserId_idempotencyKey_key" ON "DirectMessage"("senderUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────── RLS ───────────────────────────

ALTER TABLE "Conversation"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "ConversationParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationParticipant" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "DirectMessage"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DirectMessage"           FORCE  ROW LEVEL SECURITY;
ALTER TABLE "MessageReaction"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageReaction"         FORCE  ROW LEVEL SECURITY;

-- Conversation: readable to its participants. No app_user write arm -- opening
-- one writes the other person's participant row, which must not be forgeable.
CREATE POLICY conversation_select ON "Conversation"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "ConversationParticipant" p
            WHERE p."conversationId" = "Conversation"."id"
              AND p."userId" = current_setting('app.user_id', true)::text
        )
    );

CREATE POLICY superuser_bypass ON "Conversation"
    USING (current_setting('role') != 'app_user');

-- ConversationParticipant: the caller's OWN row only. See the recursion note
-- in the header -- this narrowness is what keeps the policy legal, and nothing
-- needs it wider, because the counterparty is read off a message exactly as
-- P5.2b reads it off an exchange thread.
CREATE POLICY conversation_participant_select ON "ConversationParticipant"
    FOR SELECT
    USING ("userId" = current_setting('app.user_id', true)::text);

-- The read cursor and leaving are the caller's own acts on their own row.
-- WITH CHECK repeats the USING clause so an UPDATE cannot reassign the row to
-- somebody else -- the `UserSession` lesson, where a single asymmetric policy
-- exists precisely to stop an UPDATE rewriting the ownership column.
CREATE POLICY conversation_participant_update ON "ConversationParticipant"
    FOR UPDATE
    USING ("userId" = current_setting('app.user_id', true)::text)
    WITH CHECK ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "ConversationParticipant"
    USING (current_setting('role') != 'app_user');

-- DirectMessage: readable to every participant -- which is also what makes the
-- narrow participant policy above sufficient.
CREATE POLICY direct_message_select ON "DirectMessage"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "ConversationParticipant" p
            WHERE p."conversationId" = "DirectMessage"."conversationId"
              AND p."userId" = current_setting('app.user_id', true)::text
        )
    );

-- THE REQUEST RULE, in the database.
--
-- P8's phase note: "Requests: one message, no attachments until accepted --
-- enforced in the usecase AND in WITH CHECK". Two layers because the usecase
-- is the layer a later refactor removes.
--
-- Three conjuncts:
--   1. the sender is the caller -- nobody writes in somebody else's name;
--   2. the caller is a participant;
--   3. the conversation is ACCEPTED, or it has no message yet.
--
-- (3) is what bounds a stranger to ONE message, and it reads
-- `Conversation.lastMessageAt` rather than counting messages.
--
-- THAT IS NOT A STYLE CHOICE. The obvious form --
-- `NOT EXISTS (SELECT 1 FROM "DirectMessage" m WHERE m."conversationId" = ...)`
-- -- is refused by Postgres at runtime with
--
--     ERROR: infinite recursion detected in policy for relation "DirectMessage"
--
-- A policy on T may not query T, whatever the command: the inner SELECT
-- re-enters policy evaluation for the same relation and Postgres stops it.
-- I wrote the self-referential version first, with a comment arguing that a
-- WITH CHECK resolves its own table through the SELECT policy and so does not
-- recurse. The database disagreed. What caught it was the POSITIVE control in
-- `p8-1-direct-message-rls.test.ts` -- "admits the FIRST message into a fresh
-- request" -- because the recursion refused EVERY insert, so all three
-- "REFUSES ..." tests passed while the rule enforced nothing. A suite of
-- only-negatives would have shipped this green.
--
-- So the invariant is carried on `Conversation`: a REQUEST admits a message
-- while `lastMessageAt IS NULL`, and the write that sends that message stamps
-- it. Stamping is privileged (the usecase owns it, P8.2), which is also where
-- the one-message rule's usecase half lives. `lastMessageAt` therefore
-- SERVES A SECURITY RULE as well as the inbox sort -- the column's docblock in
-- `prisma/schema/social.prisma` says so, because a later change that stopped
-- stamping it would silently let a stranger send without limit.
--
-- A DECLINED conversation admits nothing: it is not ACCEPTED, and its
-- `lastMessageAt` is set by the request message that prompted the decline.
CREATE POLICY direct_message_insert ON "DirectMessage"
    FOR INSERT
    WITH CHECK (
        "senderUserId" = current_setting('app.user_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "ConversationParticipant" p
            WHERE p."conversationId" = "DirectMessage"."conversationId"
              AND p."userId" = current_setting('app.user_id', true)::text
        )
        AND EXISTS (
            SELECT 1 FROM "Conversation" c
            WHERE c."id" = "DirectMessage"."conversationId"
              AND (c."state" = 'ACCEPTED' OR c."lastMessageAt" IS NULL)
        )
    );

-- Editing and soft-deleting are the sender's own acts. WITH CHECK repeats the
-- USING clause so an UPDATE cannot hand the message to another sender.
CREATE POLICY direct_message_update ON "DirectMessage"
    FOR UPDATE
    USING ("senderUserId" = current_setting('app.user_id', true)::text)
    WITH CHECK ("senderUserId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "DirectMessage"
    USING (current_setting('role') != 'app_user');

-- MessageReaction: visible to everyone who can read the message, written and
-- removed only by its own author. SPLIT per command for the `UserBlock`
-- reason: a single USING clause would govern DELETE too, and a participant
-- must be able to SEE a reaction they did not write without being able to
-- remove it.
CREATE POLICY message_reaction_select ON "MessageReaction"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "DirectMessage" m
            JOIN "ConversationParticipant" p
              ON p."conversationId" = m."conversationId"
            WHERE m."id" = "MessageReaction"."messageId"
              AND p."userId" = current_setting('app.user_id', true)::text
        )
    );

CREATE POLICY message_reaction_insert ON "MessageReaction"
    FOR INSERT
    WITH CHECK (
        "userId" = current_setting('app.user_id', true)::text
        AND EXISTS (
            SELECT 1 FROM "DirectMessage" m
            JOIN "ConversationParticipant" p
              ON p."conversationId" = m."conversationId"
            WHERE m."id" = "MessageReaction"."messageId"
              AND p."userId" = current_setting('app.user_id', true)::text
        )
    );

CREATE POLICY message_reaction_delete ON "MessageReaction"
    FOR DELETE
    USING ("userId" = current_setting('app.user_id', true)::text);

CREATE POLICY superuser_bypass ON "MessageReaction"
    USING (current_setting('role') != 'app_user');
