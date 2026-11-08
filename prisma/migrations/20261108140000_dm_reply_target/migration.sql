-- A reply target for a direct message — #2829, schema stage.
--
-- ============================================================================
-- P8's RULE, APPLIED PROPERLY THIS TIME
-- ============================================================================
--
-- Schema ships one release ahead of the code that writes it. P8.6's link-card
-- columns are the recorded EXCEPTION, and the reason was specific: declaring a
-- field in `ENCRYPTED_FIELDS` creates an obligation to sanitise it BY NAME at
-- its write path, and a schema-only stage has no write path to satisfy that in.
--
-- `replyToMessageId` carries neither obligation. It is an id, not content: not
-- encrypted, nothing to sanitise, and nothing for `sanitize-rich-text-coverage`
-- to want. So it ships ahead, which is the ordering #2829 asks for in those
-- words — "inventing the column inside a component PR is exactly the ordering
-- that rule exists to prevent".
ALTER TABLE "DirectMessage" ADD COLUMN "replyToMessageId" TEXT;

-- ============================================================================
-- ON DELETE SET NULL, not CASCADE
-- ============================================================================
--
-- A deleted message keeps its row — `deletedAt` is a soft delete, because the
-- conversation is two people's record — so this FK is not normally exercised
-- at all. What it decides is the case where a target row really does go, and
-- CASCADE there would take the REPLY with it: somebody else's message deleted
-- because the thing it quoted was. SET NULL loses the pointer and keeps the
-- reply, which is the direction a reader can recover from.
ALTER TABLE "DirectMessage"
    ADD CONSTRAINT "DirectMessage_replyToMessageId_fkey"
    FOREIGN KEY ("replyToMessageId") REFERENCES "DirectMessage"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- PARTIAL, because almost no message is a reply and the index only ever serves
-- "what replied to this" plus the FK's own integrity checks. The same shape
-- P8.6's attachment index uses.
CREATE INDEX "DirectMessage_replyToMessageId_idx"
    ON "DirectMessage" ("replyToMessageId")
    WHERE "replyToMessageId" IS NOT NULL;

-- ============================================================================
-- A CROSS-CONVERSATION REPLY IS REFUSED BY THE DATABASE, AND A CHECK CANNOT
-- DO IT
-- ============================================================================
--
-- The harm: a crafted request quotes a message from a conversation the sender
-- is not in, and the reply preview then decrypts it for somebody with no right
-- to it. The FK alone does not stop that — it only requires the target to
-- EXIST.
--
-- A CHECK constraint cannot express it either: Postgres forbids a subquery in
-- a CHECK, and the comparison is between two ROWS. So a trigger, which is the
-- only database mechanism that can.
--
-- NOT `SECURITY DEFINER`, deliberately. P8.2 recorded why one is a trap here:
-- the `role` GUC does not change inside a definer function, so
-- `superuser_bypass` never applies and what actually carries the write is the
-- definer's `rolsuper` — a role attribute nobody declared, which breaks
-- silently the day the app role is hardened. This trigger needs no privilege
-- crossing: it reads the same table the inserting transaction is already
-- writing.
--
-- That choice also makes it STRICTER under a user context than under the
-- privileged one. `sendDirectMessage` writes privileged, so the trigger sees
-- every row and the check is pure conversation equality. A future caller
-- writing under `app_user` has `direct_message_select` filtering the lookup,
-- so a target in a conversation they are not in is invisible, the EXISTS fails
-- and the insert is refused — the same refusal, reached by a different route.
--
-- SQLSTATE 23514 (`check_violation`) on purpose: this IS the check a CHECK
-- would have been, and a caller should not have to learn a second code for it.
CREATE OR REPLACE FUNCTION direct_message_reply_same_conversation()
RETURNS trigger AS $$
BEGIN
    IF NEW."replyToMessageId" IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "DirectMessage" target
        WHERE target."id" = NEW."replyToMessageId"
          AND target."conversationId" = NEW."conversationId"
    ) THEN
        RAISE EXCEPTION
            'replyToMessageId must name a message in the same conversation'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE, so a refusal costs nothing, and on UPDATE too: an edit that set the
-- pointer afterwards would walk straight past an INSERT-only trigger.
CREATE TRIGGER direct_message_reply_same_conversation_trg
    BEFORE INSERT OR UPDATE OF "replyToMessageId", "conversationId"
    ON "DirectMessage"
    FOR EACH ROW
    EXECUTE FUNCTION direct_message_reply_same_conversation();

-- No RLS change: a new column on a table that already carries
-- `FORCE ROW LEVEL SECURITY` and its P8.1 policy set is governed by the arms
-- already there. Postgres RLS is ROW-level, which is also the warning —
-- `conversation-columns-are-counterparty-safe` requires a written note per
-- column, because the other party reads every column of the row.
