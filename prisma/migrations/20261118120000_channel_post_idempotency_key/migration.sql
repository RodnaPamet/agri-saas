-- #3195: a client-minted key per channel post, so a retried send whose answer
-- was lost is one post. Additive and nullable; the unique index treats NULLs as
-- distinct, so every existing row (and every keyless send) is unaffected.
ALTER TABLE "ChannelPost" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "ChannelPost_authorUserId_idempotencyKey_key" ON "ChannelPost"("authorUserId", "idempotencyKey");
